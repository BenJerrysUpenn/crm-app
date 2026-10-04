// The store-coverage check for one week, against the live schedule: load the
// opening hours, closures, shift types and live shifts, then hand them to the
// pure check in lib/coverage.ts. Read-only: it selects and never writes.
//
// The "Check week" button on the schedule board runs this (via
// GET /api/schedule/check-week). It used to run inside "Publish week", which
// went away with drafts (PR #58).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addDays,
  checkWeekCoverage,
  shiftsTouchingWeek,
  type ClosedDateRange,
  type CoverageResult,
  type CoverageShift,
  type ShiftTypeCoverage,
  type StoreHoursException,
  type StoreHoursRow,
} from "@/lib/coverage";
import { isMissingInStoreColumn, isMissingTable } from "@/lib/storeHours";

/**
 *  - "ok"            — the check ran; `gaps` empty means every opening hour is covered.
 *  - "not_migrated"  — migration 24 (store hours) is not applied, so there is nothing to check against.
 *  - "unavailable"   — a read failed. Never reported as a pass.
 */
export type WeekCoverage =
  | ({ status: "ok" } & CoverageResult)
  | { status: "not_migrated" }
  | { status: "unavailable" };

export async function checkLiveWeekCoverage(supabase: SupabaseClient, weekStart: string): Promise<WeekCoverage> {
  const weekEnd = addDays(weekStart, 7);
  const lastDate = addDays(weekStart, 6);
  // Two days of lead-in so a shift that starts the evening before the week and
  // runs into its first morning is fetched; shiftsTouchingWeek trims the rest.
  const qStart = addDays(weekStart, -2) + "T00:00:00Z";
  const qEnd = addDays(weekStart, 8) + "T00:00:00Z";

  try {
    const [hours, exceptions, types, shifts, closed] = await Promise.all([
      supabase.from("store_hours").select("weekday, is_closed, opens, closes"),
      supabase
        .from("store_hours_exceptions")
        .select("date, label, is_closed, opens, closes")
        .gte("date", weekStart)
        .lt("date", weekEnd),
      supabase.from("shift_types").select("name, in_store"),
      // Live shifts only. Every shift is written published; an unpublished row
      // is a leftover draft nobody was told about, so it covers nothing.
      supabase
        .from("shifts")
        .select("starts_at, ends_at, employee_id, position")
        .eq("published", true)
        .gte("starts_at", qStart)
        .lt("starts_at", qEnd),
      // "Business closed" annotations: a day marked Closed on the board needs no
      // cover. Not load-bearing: if this read fails the check still runs, and the
      // worst case is a gap reported on a day the board says is shut.
      supabase
        .from("annotations")
        .select("title, start_date, end_date")
        .eq("business_closed", true)
        .lte("start_date", lastDate)
        .gte("end_date", weekStart),
    ]);

    const notMigrated =
      isMissingTable(hours.error) || isMissingTable(exceptions.error) || isMissingInStoreColumn(types.error);
    const otherFailure =
      (hours.error && !isMissingTable(hours.error)) ||
      (exceptions.error && !isMissingTable(exceptions.error)) ||
      (types.error && !isMissingInStoreColumn(types.error)) ||
      shifts.error;
    if (otherFailure) return { status: "unavailable" };
    if (notMigrated) return { status: "not_migrated" };

    const result = checkWeekCoverage({
      weekStart,
      storeHours: (hours.data ?? []) as StoreHoursRow[],
      exceptions: (exceptions.data ?? []) as StoreHoursException[],
      // in_store is `not null default true`; anything else reads as in-store so
      // an unclassified type can never excuse an uncovered hour.
      shiftTypes: ((types.data ?? []) as { name: string; in_store?: boolean | null }[]).map((t) => ({
        name: t.name,
        in_store: t.in_store !== false,
      })) satisfies ShiftTypeCoverage[],
      shifts: shiftsTouchingWeek((shifts.data ?? []) as CoverageShift[], weekStart),
      closedRanges: closed.error ? [] : ((closed.data ?? []) as ClosedDateRange[]),
    });
    return { status: "ok", ...result };
  } catch {
    return { status: "unavailable" };
  }
}
