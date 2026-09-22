import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { dayKey } from "@/lib/format";
import { isMissingTable, isMissingInStoreColumn } from "@/lib/storeHours";
import {
  verifyTimesheets,
  type AuditRow,
  type DealRow,
  type ProfileRow,
  type PunchRow,
  type RulingRow,
  type ShiftRow,
  type ShiftTypeRow,
} from "@/lib/payroll/verify";
import { addDays, currentPayWindow, payWindowEnding, type PayWindow } from "@/lib/payroll/window";
import type { ClosedDateRange, StoreHoursException, StoreHoursRow } from "@/lib/coverage";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// force-dynamic alone does not stop Next caching the fetches this route makes.
// Next 14 patches global fetch and caches any GET a route handler issues unless
// it says otherwise (see lib/supabase/admin.ts, and PR #12 where a cached
// "has this person clocked in?" answer was served back for a whole day). The
// URL this route asks Supabase is identical every time Verify is pressed, so
// without this a second press would answer with the first press's timesheets.
export const fetchCache = "force-no-store";

// How far back to look for deletions. A shift scheduled inside the window can
// be deleted before the window begins, so the search cannot start at the window
// — but it does not need to be unbounded either.
const DELETE_LOOKBACK_DAYS = 120;

type Supabase = ReturnType<typeof createClient>;

/**
 * GET /api/payroll/verify?window_end=YYYY-MM-DD
 *
 * The §1 timesheet checks for one pay window (bj-finance #519). Manager-only:
 * these findings name people, hours and money.
 *
 * `window_end` must be a Sunday (§0.1). Omitted, it defaults to the period that
 * has most recently finished — never to a period QBO suggests, whose dates are
 * misaligned with the ones this business runs.
 *
 * Read-only. Nothing here writes, and nothing here decides: rulings are
 * recorded through /api/payroll/rulings by the person who made them.
 */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const today = dayKey(new Date().toISOString());
  const param = new URL(request.url).searchParams.get("window_end");

  let window: PayWindow;
  if (param) {
    const resolved = payWindowEnding(param);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
    window = resolved.window;
  } else {
    window = currentPayWindow(today);
  }

  const supabase = createClient();

  // Punches and shifts are queried on a padded window and filtered precisely by
  // New York date inside the rulebook. The padding is what catches a punch that
  // started the evening before the window and ran into its first morning.
  const from = addDays(window.start, -1) + "T00:00:00Z";
  const to = addDays(window.end, 2) + "T00:00:00Z";

  const [profilesRes, punchesRes, shiftsRes] = await Promise.all([
    supabase.from("profiles").select("*"),
    supabase
      .from("time_entries")
      .select("id, employee_id, shift_id, clock_in_at, clock_out_at")
      .gte("clock_in_at", from)
      .lt("clock_in_at", to)
      .order("clock_in_at"),
    supabase
      .from("shifts")
      .select("id, employee_id, starts_at, ends_at, position, deal_id")
      .gte("starts_at", from)
      .lt("starts_at", to),
  ]);

  // These three are the check itself. A failure here is not a pass.
  for (const res of [profilesRes, punchesRes, shiftsRes]) {
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 400 });
  }

  const shifts = (shiftsRes.data ?? []) as ShiftRow[];
  const [shiftTypes, storeHours, deals, auditDeletes, rulings] = await Promise.all([
    loadShiftTypes(supabase),
    loadStoreHours(supabase, window),
    loadDeals(supabase, shifts),
    loadAuditDeletes(supabase, window),
    loadRulings(supabase, window),
  ]);

  const result = verifyTimesheets({
    window,
    today,
    punches: (punchesRes.data ?? []) as PunchRow[],
    shifts,
    shiftTypes,
    profiles: (profilesRes.data ?? []) as ProfileRow[],
    storeHours: storeHours.hours,
    storeHoursExceptions: storeHours.exceptions,
    closedRanges: storeHours.closedRanges,
    storeHoursUpdatedAt: storeHours.updatedAt,
    deals,
    auditDeletes,
    rulings: rulings.rows,
  });

  return NextResponse.json({
    ...result,
    // What the page needs to explain itself when a migration is behind the
    // deploy. The audit case is not reported here: it is a finding (1.13),
    // because an unverifiable window is a result, not a UI state.
    migrations: {
      storeHours: storeHours.ready,
      rulings: rulings.ready,
    },
  });
}

async function loadShiftTypes(supabase: Supabase): Promise<ShiftTypeRow[]> {
  const withColumn = await supabase.from("shift_types").select("name, in_store");
  if (!withColumn.error) return (withColumn.data ?? []) as ShiftTypeRow[];
  // shift_types.in_store arrives in migration 24. Without it every type reads
  // as in-store, which is the column's own default and can only over-report
  // coverage checks, never excuse a hole.
  if (!isMissingInStoreColumn(withColumn.error)) return [];
  const plain = await supabase.from("shift_types").select("name");
  return ((plain.data ?? []) as { name: string }[]).map((t) => ({ name: t.name, in_store: true }));
}

async function loadStoreHours(
  supabase: Supabase,
  window: PayWindow,
): Promise<{
  hours: StoreHoursRow[];
  exceptions: StoreHoursException[];
  closedRanges: ClosedDateRange[];
  updatedAt: string | null;
  ready: boolean;
}> {
  const empty = { hours: [], exceptions: [], closedRanges: [], updatedAt: null, ready: false };
  try {
    const [hours, exceptions, annotations] = await Promise.all([
      supabase.from("store_hours").select("weekday, is_closed, opens, closes, updated_at"),
      supabase
        .from("store_hours_exceptions")
        .select("date, label, is_closed, opens, closes")
        .gte("date", window.start)
        .lte("date", window.end),
      supabase
        .from("annotations")
        .select("title, start_date, end_date")
        .eq("business_closed", true)
        .lte("start_date", window.end)
        .gte("end_date", window.start),
    ]);
    // Before migration 24 there is nothing to read. Check 1.8 then reports
    // every day as "hours not set" rather than silently passing.
    if (hours.error || exceptions.error) return empty;

    const rows = (hours.data ?? []) as (StoreHoursRow & { updated_at: string | null })[];
    const updatedAt = rows.reduce<string | null>(
      (latest, row) => (row.updated_at && (!latest || row.updated_at > latest) ? row.updated_at : latest),
      null,
    );
    return {
      hours: rows.map((r) => ({ weekday: r.weekday, is_closed: r.is_closed, opens: r.opens, closes: r.closes })),
      exceptions: (exceptions.data ?? []) as StoreHoursException[],
      closedRanges: annotations.error ? [] : ((annotations.data ?? []) as ClosedDateRange[]),
      updatedAt,
      ready: true,
    };
  } catch {
    return empty;
  }
}

/**
 * The catering deals the window's shifts point at (§1.12). `deals` belongs to
 * the CRM app in the same Postgres; `shifts.deal_id` is a marker, not a foreign
 * key (migration 17), so a deal that is not there is a normal answer and the
 * check simply has nothing to compare against.
 */
async function loadDeals(supabase: Supabase, shifts: ShiftRow[]): Promise<DealRow[]> {
  const ids = [...new Set(shifts.map((s) => s.deal_id).filter((id): id is number => id != null))];
  if (ids.length === 0) return [];
  try {
    const { data, error } = await supabase
      .from("deals")
      .select("id, event_date, staff_count, company")
      .in("id", ids);
    if (error) return [];
    return (data ?? []) as DealRow[];
  } catch {
    return [];
  }
}

/**
 * Deletions of punches and shifts (§1.13).
 *
 * Returns null — NOT an empty list — when the audit table is not there. The two
 * are completely different answers: "nothing was deleted" versus "a deletion
 * would have left no trace", and the second is what the 2026-09-23 run had.
 * The rulebook turns the null into a blocking finding.
 */
async function loadAuditDeletes(supabase: Supabase, window: PayWindow): Promise<AuditRow[] | null> {
  try {
    const { data, error } = await supabase
      .from("row_audit")
      .select("id, table_name, row_id, op, at, actor_uid, actor_role, db_role, before_image")
      .in("table_name", ["time_entries", "shifts"])
      .eq("op", "DELETE")
      .gte("at", addDays(window.start, -DELETE_LOOKBACK_DAYS) + "T00:00:00Z")
      .order("at", { ascending: false })
      .limit(1000);
    if (isMissingTable(error)) return null;
    if (error) return null;
    return (data ?? []) as AuditRow[];
  } catch {
    return null;
  }
}

async function loadRulings(
  supabase: Supabase,
  window: PayWindow,
): Promise<{ rows: RulingRow[]; ready: boolean }> {
  try {
    const { data, error } = await supabase
      .from("payroll_rulings")
      .select("check_id, finding_key, choice, note, decided_by, decided_at")
      .eq("window_end", window.end);
    // Any error means no rulings are readable, which is the same thing for the
    // page whether the table is missing (migration 27 behind the deploy) or the
    // query failed: every ruling-class finding shows as unanswered and the
    // button stays grey. It never shows green on an unreadable table.
    if (error) return { rows: [], ready: false };
    return { rows: (data ?? []) as RulingRow[], ready: true };
  } catch {
    return { rows: [], ready: false };
  }
}
