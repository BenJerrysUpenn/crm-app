// Weekly availability repeats until a date, not forever (bj-finance #754,
// migration 48). The owner's words: "availability needs repeat until rather
// than repeat forever."
//
//   * Saving a weekly block ("Repeats every …") needs a repeat-until date. The
//     editor fills in three months from today; the person can move it.
//   * The date is inclusive: a weekly row speaks for that date and stops after
//     it (resolveDay in lib/availabilityCheck.ts, which every reader goes
//     through: the save and auto-fill checks, the schedule grid cells, the
//     team grid; and weeklyRowApplies below for the person's own calendar).
//   * Rows saved before migration 48 have none and stay open-ended until the
//     person saves them again.
//
// Pure, so the browser and `node --test` can both use it.

/** How far ahead the editor's repeat-until date starts. */
export const REPEAT_UNTIL_DEFAULT_MONTHS = 3;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * `months` calendar months after `date` (yyyy-mm-dd). A day the target month
 * does not have is the month's last day: Nov 30 + 3 months is Feb 28 (or 29).
 */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}

/** The editor's starting repeat-until date: three months from `today` (New York). */
export function defaultRepeatUntil(today: string): string {
  return addMonths(today, REPEAT_UNTIL_DEFAULT_MONTHS);
}

export const REPEAT_UNTIL_REQUIRED = "Pick the last date this repeats until.";
export const REPEAT_UNTIL_PAST = "The repeat-until date can't be in the past.";

/**
 * The repeat-until date a save of weekly availability carries, checked:
 * present, a real calendar date, and not before `today` (New York).
 */
export function parseRepeatUntil(value: unknown, today: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, error: REPEAT_UNTIL_REQUIRED };
  const v = value.trim();
  if (!isRealDate(v)) return { ok: false, error: REPEAT_UNTIL_REQUIRED };
  if (v < today) return { ok: false, error: REPEAT_UNTIL_PAST };
  return { ok: true, value: v };
}

/**
 * Does a weekly row speak for `date` on the person's own calendar? It must be
 * that weekday and not past its repeat-until date. (The calendar has always
 * shown a weekly row on every matching date, before its created_at too; only
 * the end is new.)
 */
export function weeklyRowApplies(row: { weekday: number | null; repeat_until?: string | null }, date: string, weekday: number): boolean {
  return row.weekday === weekday && repeatsOn(row.repeat_until, date);
}

/**
 * Is `date` (yyyy-mm-dd) on or before a weekly row's repeat-until date? No
 * repeat-until means open-ended. The one statement of the inclusive end, for
 * the calendar above and resolveDay in lib/availabilityCheck.ts.
 */
export function repeatsOn(repeatUntil: string | null | undefined, date: string): boolean {
  return !repeatUntil || date <= repeatUntil.slice(0, 10);
}

/** "Mon, Jan 19" for a yyyy-mm-dd date: the short form of the calendar and the schedulers' 8pm email. */
export function shortDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * True for the error PostgREST gives when availability has no repeat_until
 * column yet (migration 48 not applied): a save carrying one is refused with
 * a message saying so, never saved without its end date.
 */
export function missingRepeatUntilColumn(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return (error.code === "PGRST204" || error.code === "42703") && /repeat_until/.test(error.message ?? "");
}

export const REPEAT_UNTIL_NOT_READY =
  "Weekly availability can't be saved until the repeat-until update (migration 48) is applied. Ask a manager.";
