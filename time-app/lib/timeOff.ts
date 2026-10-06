// Which time-off requests the Team availability page still lists.
//
// A request is one row per day, grouped by `request_group` (rows without a
// group stand alone). Once a request's last day is before today, New York
// time, it is over and drops off the page, whether it was approved, denied or
// never decided. Nothing is deleted: this only decides what is shown.
//
// Pure, so `node --test` runs it.

import { dayKey } from "./format.ts";

type TimeOffRow = {
  id: number;
  employee_id: string;
  request_group: string | null;
  specific_date: string | null;
};

/** Today as YYYY-MM-DD in America/New_York, for the instant `now`. */
export function todayInNewYork(now: Date): string {
  return dayKey(now.toISOString());
}

/**
 * Is a request whose last day is `lastDate` (YYYY-MM-DD) over, as of `today`
 * (YYYY-MM-DD, New York)? A request running through today is not. A row with
 * no date has no last day, so it is never over.
 */
export function isPastTimeOff(lastDate: string | null, today: string): boolean {
  return lastDate !== null && lastDate < today;
}

/** The request a row belongs to: its group, or the row alone. */
export function timeOffGroupKey(row: TimeOffRow): string {
  return `${row.employee_id}|${row.request_group ?? "single-" + row.id}`;
}

/** The rows of every request that is not over as of `today`, in their original order. */
export function dropPastTimeOff<T extends TimeOffRow>(rows: T[], today: string): T[] {
  const lastDate = new Map<string, string | null>();
  for (const r of rows) {
    const key = timeOffGroupKey(r);
    const seen = lastDate.get(key) ?? null;
    const later = r.specific_date !== null && (seen === null || r.specific_date > seen);
    lastDate.set(key, later ? r.specific_date : seen);
  }
  return rows.filter((r) => !isPastTimeOff(lastDate.get(timeOffGroupKey(r)) ?? null, today));
}
