// Sanity checks on a shift's own shape, as opposed to how a week of shifts
// covers the store's opening hours (that is lib/coverage.ts).
//
// Why this exists: catering deal 25156 (Terrain, 2026-09-27) produced shift 350
// running 13:30 on the 27th to 15:30 on the 28th — twenty-six hours — and it was
// published. The deal's labor_hours went straight into the shift's length with
// nothing in between asking whether a human being could work it. Nothing here
// tries to guess the right end time; it only refuses to let an impossible one
// through without somebody saying yes on purpose.
//
// Pure and dependency-free, like lib/coverage.ts, so `node --test` can run it.

import { formatClock, formatDayLabel, formatMinutes, nyWallClock } from "./coverage.ts";

/**
 * At or above this many hours, a shift needs a human to confirm it.
 *
 * Fifteen hours is well past any real shift this business runs — the longest
 * genuine day is a catering event with travel either side, around ten — while
 * still leaving room above a long one. It is not catering-specific on purpose:
 * a 26-hour "PENN Closer" is just as wrong as a 26-hour "Catering".
 *
 * The root CRM app repeats this number in lib/cateringShifts.ts, which is a
 * separate Next app with its own tsconfig (the root tsconfig excludes
 * time-app/), so the two cannot share a module. Change both together.
 */
export const LONG_SHIFT_HOURS = 15;

/** Just enough of a shift to judge its length. */
export type ShiftForLengthCheck = {
  id?: number | null;
  employee_id?: string | null;
  position?: string | null;
  starts_at: string;
  ends_at: string;
};

/** A shift long enough to be worth questioning. `hours` is rounded for display. */
export type LongShift = {
  id: number | null;
  employee_id: string | null;
  position: string | null;
  starts_at: string;
  ends_at: string;
  hours: number;
};

/**
 * Elapsed hours between two instants, rounded to two decimals for display.
 *
 * Real elapsed time, not wall clock: a shift that spans the spring-forward hour
 * is an hour shorter than its clock faces suggest, and it is the hours a person
 * is actually on their feet that make a shift impossible. Returns 0 for
 * unparseable or backwards input — those are the create/edit routes' problem,
 * flagged there with a readable 400 rather than smuggled in as a length.
 */
export function shiftHours(startsAt: string, endsAt: string): number {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return Math.round(((end - start) / 3600000) * 100) / 100;
}

/** True when this shift is at or over the threshold. */
export function isLongShift(startsAt: string, endsAt: string): boolean {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return false;
  // Compare the exact elapsed time, not the rounded display value, so 14.999
  // hours is not rounded up into a refusal.
  return (end - start) / 3600000 >= LONG_SHIFT_HOURS;
}

/** Every suspiciously long shift in the list, in the order given. */
export function findLongShifts(shifts: ShiftForLengthCheck[]): LongShift[] {
  return shifts
    .filter((s) => isLongShift(s.starts_at, s.ends_at))
    .map((s) => ({
      id: s.id ?? null,
      employee_id: s.employee_id ?? null,
      position: s.position ?? null,
      starts_at: s.starts_at,
      ends_at: s.ends_at,
      hours: shiftHours(s.starts_at, s.ends_at),
    }));
}

/** "26" for a whole number of hours, "15.5" otherwise. */
export function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : String(Number(hours.toFixed(2)));
}

/** "Sun Sep 27, 1:30 PM" — an instant as New York wall clock. */
export function formatInstant(iso: string): string {
  const { date, minutes } = nyWallClock(iso);
  return `${formatDayLabel(date)}, ${formatClock(formatMinutes(minutes))}`;
}

/**
 * "Catering shift Sun Sep 27, 1:30 PM to Mon Sep 28, 3:30 PM is 26 hours long.
 * Check the end time."
 *
 * The position leads so a catering one reads as what it is; a shift with no
 * position just says "Shift".
 */
export function describeLongShift(shift: LongShift): string {
  const what = shift.position ? `${shift.position} shift` : "Shift";
  return `${what} ${formatInstant(shift.starts_at)} to ${formatInstant(shift.ends_at)} is ${formatHours(shift.hours)} hours long. Check the end time.`;
}
