import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
import {
  checkWeekCoverage,
  selectWeekShifts,
  type ClosedDateRange,
  type CoverageResult,
  type CoverageShift,
  type ShiftTypeCoverage,
  type StoreHoursException,
  type StoreHoursRow,
} from "@/lib/coverage";
import { findLongShifts } from "@/lib/shiftChecks";
import { isMissingTable, isMissingInStoreColumn } from "@/lib/storeHours";
import { NextResponse } from "next/server";

function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

type Supabase = ReturnType<typeof createClient>;

type CoverageInputs = {
  storeHours: StoreHoursRow[];
  exceptions: StoreHoursException[];
  shiftTypes: ShiftTypeCoverage[];
};

/**
 * Three outcomes, deliberately distinguished:
 *
 *  - "ok"            — run the check.
 *  - "not_migrated"  — migration 24 has not been applied. Publishing carries on
 *                      exactly as it did before the check existed, because the
 *                      feature genuinely is not installed yet.
 *  - "unavailable"   — something else went wrong: a timeout, an RLS change, a
 *                      transient 5xx. The check is the whole point of this
 *                      route, so a failure to run it must not read as a pass.
 */
type CoverageLoad =
  | { status: "ok"; inputs: CoverageInputs }
  | { status: "not_migrated" }
  | { status: "unavailable" };

/**
 * Load everything the coverage check needs.
 *
 * The migration is applied by hand, so a deploy can land ahead of it — that
 * case has to degrade quietly. Everything else has to be loud: silently
 * skipping the check on a timeout would let exactly the bug this route exists
 * to prevent slip through, with no sign anything was wrong.
 */
async function loadCoverageInputs(
  supabase: Supabase,
  weekStart: string,
  weekEnd: string,
): Promise<CoverageLoad> {
  try {
    const [hours, exceptions, types] = await Promise.all([
      supabase.from("store_hours").select("weekday, is_closed, opens, closes"),
      supabase
        .from("store_hours_exceptions")
        .select("date, label, is_closed, opens, closes")
        .gte("date", weekStart)
        .lt("date", weekEnd),
      supabase.from("shift_types").select("name, in_store"),
    ]);

    // The store-hours tables arrive in migration 24; so does shift_types.in_store.
    const notMigrated =
      isMissingTable(hours.error) || isMissingTable(exceptions.error) || isMissingInStoreColumn(types.error);
    // Any error that is NOT the missing migration means we could not check.
    const otherFailure =
      (hours.error && !isMissingTable(hours.error)) ||
      (exceptions.error && !isMissingTable(exceptions.error)) ||
      (types.error && !isMissingInStoreColumn(types.error));

    if (otherFailure) return { status: "unavailable" };
    if (notMigrated) return { status: "not_migrated" };

    return {
      status: "ok",
      inputs: {
        storeHours: (hours.data ?? []) as StoreHoursRow[],
        exceptions: (exceptions.data ?? []) as StoreHoursException[],
        // in_store is `not null default true`; anything else reads as in-store so
        // an unclassified type can never excuse an uncovered hour.
        shiftTypes: ((types.data ?? []) as { name: string; in_store?: boolean | null }[]).map((t) => ({
          name: t.name,
          in_store: t.in_store !== false,
        })) satisfies ShiftTypeCoverage[],
      },
    };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * "Business closed" schedule annotations overlapping the week (migration 16:
 * public.annotations, with inclusive start_date/end_date). A day the manager
 * has already marked Closed on the board needs no cover.
 *
 * Unlike the store-hours tables this one is not load-bearing: if the query
 * fails we carry on with an empty list and still run the coverage check. The
 * worst case is a reported gap on a day the board says is shut, which the
 * manager can publish through — better than skipping the check entirely.
 */
async function loadClosedRanges(supabase: Supabase, weekStart: string, lastDate: string): Promise<ClosedDateRange[]> {
  try {
    const { data, error } = await supabase
      .from("annotations")
      .select("title, start_date, end_date")
      .eq("business_closed", true)
      .lte("start_date", lastDate)
      .gte("end_date", weekStart);
    if (error) return [];
    return (data ?? []) as ClosedDateRange[];
  } catch {
    return [];
  }
}

// Publish every draft shift in the given week.
// Body: { weekStart: "YYYY-MM-DD", force?: boolean }
//
// Two checks run before anything is published:
//
//  1. Coverage — do in-store shifts cover every hour the store is open? A hole
//     in the published schedule means nobody behind the counter with the door
//     open, which is the bug this route was built to stop.
//  2. Length — is any shift 15+ hours? Catering deal 25156 produced a published
//     26-hour shift because the deal's labor_hours became the shift's length
//     unquestioned. This check needs nothing from migration 24, so it runs even
//     when the store-hours tables are missing.
//
// Either one stops the publish with a 409 carrying both results.
//
// force: true is the manager's override. It covers "publish despite the gaps",
// "publish despite the long shift", and "publish even though the coverage check
// could not run".
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await request.json();
  const weekStart = body?.weekStart;
  const force = body?.force === true;
  if (!weekStart) return NextResponse.json({ error: "weekStart required" }, { status: 400 });
  const weekEnd = addDays(weekStart, 7);
  // Two days of lead-in, not one, so a shift that starts the evening before the
  // week and runs into its first morning is fetched. It is not publishable
  // here, but it does cover the store, and a check that could not see it would
  // invent a gap at Sunday open.
  const qStart = addDays(weekStart, -2) + "T00:00:00Z";
  const qEnd = addDays(weekStart, 8) + "T00:00:00Z";

  const supabase = createClient();
  // Everything in the padded window, published or not: the drafts to publish
  // and the shifts already live, which together are the week as it will look.
  const { data: windowShifts, error } = await supabase
    .from("shifts")
    .select("id, employee_id, starts_at, ends_at, position, published")
    .gte("starts_at", qStart)
    .lt("starts_at", qEnd);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // publishable: exactly what this route has always published (unpublished,
  // starting in the week). forCoverage: wider, so an overnight shift spilling
  // in from Saturday counts towards Sunday morning. See selectWeekShifts.
  const { publishable: inWeek, forCoverage: coverageShifts } = selectWeekShifts(windowShifts ?? [], weekStart);

  // Length is judged on the same set as coverage, and needs no store-hours
  // tables — so a 26-hour shift is caught even on an unmigrated database.
  const longShifts = findLongShifts(coverageShifts);

  const load = await loadCoverageInputs(supabase, weekStart, weekEnd);
  // The outage comes first: it is the one the manager can do something about by
  // waiting. Once it clears they see whatever the checks actually found.
  if (load.status === "unavailable" && !force) {
    return NextResponse.json({ error: "coverage_unavailable" }, { status: 503 });
  }

  let coverage: CoverageResult | null = null;
  if (load.status === "ok") {
    const closedRanges = await loadClosedRanges(supabase, weekStart, addDays(weekStart, 6));
    coverage = checkWeekCoverage({
      weekStart,
      storeHours: load.inputs.storeHours,
      exceptions: load.inputs.exceptions,
      shiftTypes: load.inputs.shiftTypes,
      shifts: coverageShifts as CoverageShift[],
      closedRanges,
    });
  }

  const gaps = coverage?.gaps ?? [];
  if (!force && (gaps.length > 0 || longShifts.length > 0)) {
    return NextResponse.json(
      {
        error: "schedule_checks",
        gaps,
        longShifts,
        hoursNotSet: coverage?.hoursNotSet ?? [],
      },
      { status: 409 },
    );
  }

  // Days whose hours nobody has set never block the publish; they ride along on
  // the success response so the board can nag the manager to set them.
  const extras = coverage ? { hoursNotSet: coverage.hoursNotSet } : { coverageSkipped: true as const };

  if (inWeek.length === 0) return NextResponse.json({ ok: true, published: 0, ...extras });

  const { error: upErr } = await supabase
    .from("shifts")
    .update({ published: true, updated_at: new Date().toISOString() })
    .in("id", inWeek.map((s) => s.id));
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 400 });

  // Notify each assigned employee about their newly posted shift(s).
  for (const s of inWeek) {
    if (!s.employee_id) continue;
    const email = await emailForUser(s.employee_id as string);
    const { data: emp } = await supabase.from("profiles").select("phone").eq("id", s.employee_id).maybeSingle();
    await notify({
      userId: s.employee_id as string,
      type: "shift_published",
      title: "New shift posted",
      body: `${fmtDate(s.starts_at as string)} · ${fmtTime(s.starts_at as string)}–${fmtTime(s.ends_at as string)}${s.position ? " · " + s.position : ""}`,
      phone: emp?.phone ?? null,
      email,
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, published: inWeek.length, ...extras });
}
