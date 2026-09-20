import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
import {
  checkWeekCoverage,
  type ClosedDateRange,
  type CoverageResult,
  type CoverageShift,
  type ShiftTypeCoverage,
  type StoreHoursException,
  type StoreHoursRow,
} from "@/lib/coverage";
import { NextResponse } from "next/server";

const TZ = "America/New_York";
function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function nyDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

type Supabase = ReturnType<typeof createClient>;

/**
 * Load everything the coverage check needs.
 *
 * Returns null when the store-hours tables (or shift_types.in_store) are not
 * there yet — migration 24 is applied by hand, so a deploy can land ahead of
 * it. In that case publishing must carry on exactly as it did before rather
 * than 500, and the response says so with coverageSkipped.
 */
async function loadCoverageInputs(
  supabase: Supabase,
  weekStart: string,
  weekEnd: string,
): Promise<{ storeHours: StoreHoursRow[]; exceptions: StoreHoursException[]; shiftTypes: ShiftTypeCoverage[] } | null> {
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
    if (hours.error || exceptions.error || types.error) return null;
    return {
      storeHours: (hours.data ?? []) as StoreHoursRow[],
      exceptions: (exceptions.data ?? []) as StoreHoursException[],
      // in_store is `not null default true`; anything else reads as in-store so
      // an unclassified type can never excuse an uncovered hour.
      shiftTypes: ((types.data ?? []) as { name: string; in_store?: boolean | null }[]).map((t) => ({
        name: t.name,
        in_store: t.in_store !== false,
      })) satisfies ShiftTypeCoverage[],
    };
  } catch {
    return null;
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
// Before anything is published we check that in-store shifts cover every hour
// the store is open that week. Gaps stop the publish with a 409 unless the
// manager sends force: true — a hole in the published schedule means nobody is
// behind the counter with the door open, which is what this guards against.
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await request.json();
  const weekStart = body?.weekStart;
  const force = body?.force === true;
  if (!weekStart) return NextResponse.json({ error: "weekStart required" }, { status: 400 });
  const weekEnd = addDays(weekStart, 7);
  const qStart = addDays(weekStart, -1) + "T00:00:00Z";
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

  const weekShifts = (windowShifts ?? []).filter((s) => {
    const d = nyDate(s.starts_at as string);
    return d >= weekStart && d < weekEnd;
  });
  const inWeek = weekShifts.filter((s) => !s.published);

  const inputs = await loadCoverageInputs(supabase, weekStart, weekEnd);
  let coverage: CoverageResult | null = null;
  if (inputs) {
    const closedRanges = await loadClosedRanges(supabase, weekStart, addDays(weekStart, 6));
    coverage = checkWeekCoverage({
      weekStart,
      storeHours: inputs.storeHours,
      exceptions: inputs.exceptions,
      shiftTypes: inputs.shiftTypes,
      shifts: weekShifts as CoverageShift[],
      closedRanges,
    });
    if (coverage.gaps.length > 0 && !force) {
      return NextResponse.json(
        { error: "coverage_gaps", gaps: coverage.gaps, hoursNotSet: coverage.hoursNotSet },
        { status: 409 },
      );
    }
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
