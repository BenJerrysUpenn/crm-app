// The pay window: which fourteen days a run covers, and when it pays.
//
// Payroll spec §0.1 (bj-finance #519): "period = the 14 days ending the most
// recent Sunday; pay date = end + 3 (Wed). Never read
// `upcoming_pay_periods[].pay_date` (misaligned)."
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
 * The most recent Sunday on or before `date` — the end of the period that has
 * finished. Run on a Sunday it returns that same Sunday, which is right: the
 * period ends at the end of that day and the run happens after it.
 */
export function mostRecentSunday(date: string): string {
  return addDays(date, -weekdayOf(date));
}

export type WindowResult = { ok: true; window: PayWindow } | { ok: false; error: string };

/**
 * Build the window that ends on `end`.
 *
 * `end` must be a Sunday. This is checked rather than rounded: a request for a
 * window ending on a Tuesday is somebody misunderstanding the period, and
 * quietly answering about a different fortnight than they asked for is worse
 * than refusing.
 */
export function payWindowEnding(end: string): WindowResult {
  if (!isISODate(end)) return { ok: false, error: "window_end must be a date like 2026-09-20." };
  if (weekdayOf(end) !== 0)
    return { ok: false, error: `Pay periods end on a Sunday; ${end} is not one.` };
  return {
    ok: true,
    window: {
      start: addDays(end, -(PERIOD_DAYS - 1)),
      end,
      payDate: addDays(end, PAY_DATE_OFFSET),
    },
  };
}

/** The window for the period that has most recently finished, as of `today`. */
export function currentPayWindow(today: string): PayWindow {
  const result = payWindowEnding(mostRecentSunday(today));
  // mostRecentSunday always returns a Sunday, so this cannot fail.
  if (!result.ok) throw new Error(result.error);
  return result.window;
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
