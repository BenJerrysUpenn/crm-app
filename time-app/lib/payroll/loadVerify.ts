// Loads everything the §1 rulebook needs for one pay window and runs it.
//
// Shared by GET /api/payroll/verify (the Finance tab and the schedule's
// solo-close dropdowns) and POST /api/payroll/approve, so the approval is
// checked against exactly the result a manager was looking at. Server-only:
// it takes the request's Supabase client, so every read runs under the
// manager's own RLS. Read-only.

import type { createClient } from "@/lib/supabase/server";
import { isMissingTable, isMissingInStoreColumn } from "@/lib/storeHours";
import {
  EVENT_DEAL_STAGES,
  verifyTimesheets,
  type ApprovalRow,
  type AuditRow,
  type DealRow,
  type ProfileRow,
  type PunchRow,
  type RulingRow,
  type ShiftRow,
  type ShiftTypeRow,
  type VerifyResult,
} from "@/lib/payroll/verify";
import { PERIOD_DAYS, addDays, type PayWindow } from "@/lib/payroll/window";
import type { HeldTipRow } from "@/lib/payroll/heldTips";
import type { ClosedDateRange, StoreHoursException, StoreHoursRow } from "@/lib/coverage";

// How far back to look for deletions. A shift scheduled inside the window can
// be deleted before the window begins, so the search cannot start at the window
// — but it does not need to be unbounded either.
const DELETE_LOOKBACK_DAYS = 120;

type Supabase = ReturnType<typeof createClient>;

export type LoadedVerify = VerifyResult & {
  migrations: { storeHours: boolean; rulings: boolean; approvals: boolean };
  /** Today in New York, as the server saw it: the approval gate's calendar. */
  today: string;
  /** Approved runs of OTHER windows that share days with this one. */
  otherApprovals: ApprovalRow[];
};

export async function loadVerify(
  supabase: Supabase,
  window: PayWindow,
  today: string,
): Promise<{ ok: true; result: LoadedVerify } | { ok: false; error: string }> {
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
    if (res.error) return { ok: false, error: res.error.message };
  }

  const shifts = (shiftsRes.data ?? []) as ShiftRow[];
  const [shiftTypes, storeHours, deals, windowDeals, auditDeletes, approval, unmatchedTips] = await Promise.all([
    loadShiftTypes(supabase),
    loadStoreHours(supabase, window),
    loadDeals(supabase, shifts),
    loadWindowDeals(supabase, window),
    loadAuditDeletes(supabase, window),
    loadApprovals(supabase, window),
    loadUnmatchedTips(supabase),
  ]);

  const input = {
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
    windowDeals,
    auditDeletes,
    approval: approval.row,
    otherApprovals: approval.others,
    unmatchedTips,
  };

  // Two passes. Choices are keyed by CASE, not by pay window (migration 27):
  // a solo-close night chosen on the schedule does not know which fortnight
  // will verify it. So the rulebook runs once to learn which cases exist, the
  // choices for exactly those cases are read, and it runs again with them.
  const cases = verifyTimesheets(input)
    .findings.filter((f) => f.status === "needs_ruling")
    .map((f) => f.key);
  const rulings = await loadRulings(supabase, cases);
  const result = verifyTimesheets({ ...input, rulings: rulings.rows });

  return {
    ok: true,
    result: {
      ...result,
      // What the page needs to explain itself when a migration is behind the
      // deploy. The audit case is not reported here: it is a finding (1.13),
      // because an unverifiable window is a result, not a UI state.
      migrations: { storeHours: storeHours.ready, rulings: rulings.ready, approvals: approval.ready },
      today,
      otherApprovals: approval.others,
    },
  };
}

/**
 * §3.4 — invoice tips with no deal, from all history (held_tips, migration 26).
 * A flag on the Finance tab, never a block (ruling A, 2026-09-22). Before
 * migration 26 there is nothing to read, and nothing is shown: the payroll
 * sheet still lists every unmatched tip from Square itself.
 */
async function loadUnmatchedTips(supabase: Supabase): Promise<HeldTipRow[]> {
  const res = await supabase
    .from("held_tips")
    .select("id, deal_id, payer, tip_cents, paid_date, event_date, status, released_in_run, source_payment_id, note")
    .is("deal_id", null)
    .order("paid_date");
  return res.error ? [] : ((res.data ?? []) as HeldTipRow[]);
}

async function loadShiftTypes(supabase: Supabase): Promise<ShiftTypeRow[]> {
  const withColumn = await supabase.from("shift_types").select("name, in_store");
  if (!withColumn.error) return (withColumn.data ?? []) as ShiftTypeRow[];
  // shift_types.in_store arrives in migration 24. Without it every type reads
  // as in-store — the column's own default, and the same choice lib/coverage.ts
  // makes for an unrecognised position, so the two checks agree about a
  // database that is behind the deploy. It is not a free choice either way: it
  // lets a Catering punch look like cover (1.8 under-reports), where the
  // opposite would invent gaps on every catering evening. This is the fallback
  // for a MISSING COLUMN only; any other error returns nothing rather than
  // guessing, which has the same effect but without pretending it read
  // something.
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
  cases: string[],
): Promise<{ rows: RulingRow[]; ready: boolean }> {
  try {
    // Asked even with no cases, so a missing table is still noticed.
    const { data, error } = await supabase
      .from("payroll_rulings")
      .select("check_id, finding_key, choice, payee_id, note, decided_by, decided_at")
      .in("finding_key", cases.length > 0 ? cases : ["-"]);
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

/**
 * §3.5 — the window's event deals, by event date. `deals.event_date` is text
 * holding an ISO date (the CRM's column), so a text range is the right rows.
 * Any error reads as "no deals" rather than failing Verify: 3.5 then simply
 * asks nothing, and the payroll sheet still applies its default to any
 * crewless tip it finds.
 */
async function loadWindowDeals(supabase: Supabase, window: PayWindow): Promise<DealRow[]> {
  try {
    const { data, error } = await supabase
      .from("deals")
      .select("id, event_date, staff_count, company, stage")
      .gte("event_date", window.start)
      .lte("event_date", window.end + "T23:59:59")
      .in("stage", [...EVENT_DEAL_STAGES]);
    if (error) return [];
    return (data ?? []) as DealRow[];
  } catch {
    return [];
  }
}

/**
 * The run's approval, if any, and the approvals of other windows that share
 * any of its fourteen days (window_end within 13 days either side). Approval is
 * final and locks every choice dated in its window, so a case here can be
 * locked by a neighbouring run as well as its own. Missing table (migration
 * 27) → not approvable.
 */
async function loadApprovals(
  supabase: Supabase,
  window: PayWindow,
): Promise<{ row: ApprovalRow | null; others: ApprovalRow[]; ready: boolean }> {
  try {
    const { data, error } = await supabase
      .from("payroll_run_approvals")
      .select("window_end, approved_by, approved_at, status")
      .gte("window_end", window.start)
      .lte("window_end", addDays(window.end, PERIOD_DAYS - 1));
    if (error) return { row: null, others: [], ready: false };
    const rows = (data ?? []) as ApprovalRow[];
    return {
      row: rows.find((r) => r.window_end === window.end) ?? null,
      others: rows.filter((r) => r.window_end !== window.end),
      ready: true,
    };
  } catch {
    return { row: null, others: [], ready: false };
  }
}
