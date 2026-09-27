// The pay window: which fourteen days a run covers, and when it pays.
//
// Payroll spec §0.1 (bj-finance #519): "period = the 14 days ending the most
// recent Sunday; pay date = end + 3 (Wed). Never read
// `upcoming_pay_periods[].pay_date` (misaligned)." Ruled 2026-09-27: periods
// end every OTHER Sunday, on the cycle through 2026-09-20, and the default is
// the most recent period that has ended.
//
// That last sentence is the whole reason this is computed here rather than read
// from QuickBooks. QBO's own upcoming-period list is out of step with the
// periods this business actually runs, and the 2026-09-23 run had to correct
// both the period dropdown and the pay date by hand on the run screen (§6, steps
// 2 and 3). The dates are arithmetic on a calendar, so they are arithmetic here.
//
// Everything is a plain YYYY-MM-DD date string in America/New_York. No instants,
// no timezone conversion: a pay period is a run of calendar days, and treating
// it as a range of instants is how a DST weekend silently moves a boundary.
//
// Pure, so `node --test` runs it. The date arithmetic and the ISO-date check
// come from the modules that already own them — one copy of each, rather than
// a payroll-flavoured second opinion about what a calendar day is.

import { addDays, weekdayOf } from "../coverage.ts";
import { isISODate } from "../holidays.ts";

export { addDays, isISODate, weekdayOf };

/** Days in a pay period. Biweekly, Monday through Sunday. */
export const PERIOD_DAYS = 14;

/** Days from period end to pay date: Sunday + 3 = Wednesday. */
export const PAY_DATE_OFFSET = 3;

export type PayWindow = {
  /** First day of the period, a Monday. YYYY-MM-DD. */
  start: string;
  /** Last day of the period, a Sunday. YYYY-MM-DD, inclusive. */
  end: string;
  /** Wednesday after the period ends. YYYY-MM-DD. */
  payDate: string;
};

/**
 * A known period end. Pay periods end every OTHER Sunday, on the cycle through
 * this date (ruled 2026-09-27, #519): 2026-09-20, 10-04, 10-18, 11-01 and so
 * on. Any Sunday is not enough: the Sunday in the middle of a period would
 * give a window that straddles two runs. Migration 27 holds the database to
 * the same cycle with the same anchor.
 */
export const PERIOD_ANCHOR_END = "2026-09-20";

const MS_DAY = 86_400_000;

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
function daysFrom(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_DAY);
}

/** Is `date` the last day of a pay period: a Sunday on the fortnightly cycle? */
export function isPeriodEnd(date: string): boolean {
  if (!isISODate(date)) return false;
  const offset = daysFrom(PERIOD_ANCHOR_END, date);
  return ((offset % PERIOD_DAYS) + PERIOD_DAYS) % PERIOD_DAYS === 0;
}

/** The last day of the pay period `date` falls in: the next period end on or after it. */
export function periodEndFor(date: string): string {
  const offset = daysFrom(PERIOD_ANCHOR_END, date);
  return addDays(PERIOD_ANCHOR_END, Math.ceil(offset / PERIOD_DAYS) * PERIOD_DAYS);
}

/**
 * The end of the most recent period that has ENDED as of `today`. A period
 * ends at the end of its Sunday, so on that Sunday it is still running and the
 * one before it is the answer.
 */
export function mostRecentPeriodEnd(today: string): string {
  return addDays(periodEndFor(today), -PERIOD_DAYS);
}

/** The period ends covering every day from `from` to `to` (a span of up to 14 days). */
export function periodEndsCovering(from: string, to: string): string[] {
  const first = periodEndFor(from);
  const last = periodEndFor(to);
  return first === last ? [first] : [first, last];
}

export type WindowResult = { ok: true; window: PayWindow } | { ok: false; error: string };

/**
 * Build the window that ends on `end`.
 *
 * `end` must be a period end: a Sunday on the fortnightly cycle. This is
 * checked rather than rounded: a request for a window ending on a Tuesday, or
 * on the Sunday in the middle of a period, is somebody misunderstanding the
 * period, and quietly answering about a different fortnight than they asked
 * for is worse than refusing.
 */
export function payWindowEnding(end: string): WindowResult {
  if (!isISODate(end)) return { ok: false, error: "window_end must be a date like 2026-09-20." };
  if (weekdayOf(end) !== 0)
    return { ok: false, error: `Pay periods end on a Sunday; ${end} is not one.` };
  if (!isPeriodEnd(end))
    return {
      ok: false,
      error: `Pay periods end every other Sunday (${PERIOD_ANCHOR_END}, ${addDays(PERIOD_ANCHOR_END, PERIOD_DAYS)} and so on); ${end} is the middle of the period ending ${periodEndFor(end)}.`,
    };
  return {
    ok: true,
    window: {
      start: addDays(end, -(PERIOD_DAYS - 1)),
      end,
      payDate: addDays(end, PAY_DATE_OFFSET),
    },
  };
}

/** The window for the period that has most recently ended, as of `today`. */
export function currentPayWindow(today: string): PayWindow {
  const result = payWindowEnding(mostRecentPeriodEnd(today));
  // mostRecentPeriodEnd always returns a period end, so this cannot fail.
  if (!result.ok) throw new Error(result.error);
  return result.window;
}

/**
 * Has the period ended, as of `today` (YYYY-MM-DD, New York)? Only then can
 * its run be submitted (ruled 2026-09-22): the period ends at the end of its
 * Sunday, so on that Sunday it has not. Migration 27's submittal trigger holds
 * the database to the same rule.
 */
export function periodEnded(window: PayWindow, today: string): boolean {
  return today > window.end;
}

/** The first day a run can be submitted: the Monday after the period. */
export function firstSubmittalDay(window: PayWindow): string {
  return addDays(window.end, 1);
}

/** Is this date inside the window? Both ends inclusive. */
export function inWindow(date: string, window: PayWindow): boolean {
  return date >= window.start && date <= window.end;
}

/** Every date in the window, in order. */
export function windowDates(window: PayWindow): string[] {
  return Array.from({ length: PERIOD_DAYS }, (_, i) => addDays(window.start, i));
}

/**
 * The two payroll weeks. PA computes overtime per single week (§2.3), so the
 * fortnight is never summed for that purpose — a person can work 45 hours in
 * week one and 20 in week two and be owed five hours of overtime, which a
 * fortnight total of 65 would hide.
 */
export function payWeeks(window: PayWindow): { start: string; end: string }[] {
  return [
    { start: window.start, end: addDays(window.start, 6) },
    { start: addDays(window.start, 7), end: window.end },
  ];
}
