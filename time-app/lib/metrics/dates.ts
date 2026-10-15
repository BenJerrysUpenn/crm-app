// Calendar arithmetic for the Metrics page (bj-finance #671), on plain
// "YYYY-MM-DD" day keys in the business timezone (America/New_York). A day
// key is a calendar date, not an instant, so everything here is done in UTC
// on purpose: no daylight-saving hour can move a day.
//
// Weeks run Monday to Sunday and are named by their Monday, as the payroll
// fortnight and the bj-finance feed name them.

const DAY_MS = 86_400_000;

/** Today's day key in New York. */
export function nyToday(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** The day key of an ISO timestamp or date-ish text, in New York. */
export function nyDay(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Hours from one ISO instant to another; 0 when the second is not after the first. */
export function spanHours(startIso: string, endIso: string): number {
  return Math.max(0, (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000);
}

function toUtc(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * DAY_MS);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** The Monday of the week holding `day`. */
export function mondayOf(day: string): string {
  const dow = new Date(toUtc(day)).getUTCDay(); // 0 = Sunday
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}

/** "YYYY-MM-01" for the month holding `day`. */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function daysInMonth(day: string): number {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthEnd(day: string): string {
  return `${day.slice(0, 7)}-${String(daysInMonth(day)).padStart(2, "0")}`;
}

/** The first day of the month `n` months after the one holding `day` (n may be negative). */
export function addMonths(day: string, n: number): string {
  const [y, m] = day.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return fromUtc(d.getTime());
}

/** Every day from `from` to `to`, both included. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The Mondays of the `n` weeks ending with the week holding `day`, oldest first. */
export function lastWeeks(day: string, n: number): string[] {
  const last = mondayOf(day);
  return Array.from({ length: n }, (_, i) => addDays(last, -7 * (n - 1 - i)));
}

/** The first days of the `n` months ending with the month holding `day`, oldest first. */
export function lastMonths(day: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addMonths(day, -(n - 1 - i)));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 2026" */
export function monthLabel(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** "Oct 6" */
export function shortDay(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
}
