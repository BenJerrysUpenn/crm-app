// US holidays, computed from the year rather than listed per year, so this
// keeps working in 2030 without anyone editing a table.
//
// A holiday is a calendar date, not an instant, so these are plain
// "YYYY-MM-DD" strings and there is no timezone to get wrong. The Date objects
// used inside are UTC-only and never leave this file.

export type Holiday = { name: string; date: string };

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

// Day of week (0 = Sunday) for a civil date, read through UTC so no local
// offset can shift it.
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// The nth <weekday> of a month, e.g. the 3rd Monday of January.
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const offset = (weekday - dayOfWeek(year, month, 1) + 7) % 7;
  return iso(year, month, 1 + offset + (n - 1) * 7);
}

// The last <weekday> of a month, e.g. the last Monday of May.
function lastWeekday(year: number, month: number, weekday: number): string {
  const last = daysInMonth(year, month);
  const back = (dayOfWeek(year, month, last) - weekday + 7) % 7;
  return iso(year, month, last - back);
}

// Easter Sunday in the Gregorian calendar (Meeus/Jones/Butcher computus).
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return iso(year, Math.floor(n / 31), (n % 31) + 1);
}

// Every holiday the store cares about, for one calendar year, date-ascending.
// These are observance dates (the actual day), not the federal "observed"
// weekday shuffle — the store opens on the day itself, not the Monday after.
export function holidaysForYear(year: number): Holiday[] {
  const list: Holiday[] = [
    { name: "New Year's Day", date: iso(year, 1, 1) },
    { name: "Martin Luther King Jr. Day", date: nthWeekday(year, 1, 1, 3) },
    { name: "Presidents' Day", date: nthWeekday(year, 2, 1, 3) },
    { name: "Easter Sunday", date: easterSunday(year) },
    { name: "Memorial Day", date: lastWeekday(year, 5, 1) },
    { name: "Juneteenth", date: iso(year, 6, 19) },
    { name: "Independence Day", date: iso(year, 7, 4) },
    { name: "Labor Day", date: nthWeekday(year, 9, 1, 1) },
    { name: "Thanksgiving", date: nthWeekday(year, 11, 4, 4) },
    { name: "Christmas Eve", date: iso(year, 12, 24) },
    { name: "Christmas Day", date: iso(year, 12, 25) },
    { name: "New Year's Eve", date: iso(year, 12, 31) },
  ];
  return list.sort((x, y) => x.date.localeCompare(y.date));
}

// Holidays falling in [fromISO, toISO], both ends inclusive. Both arguments
// are "YYYY-MM-DD". Returns [] if the range is empty or backwards.
export function holidaysBetween(fromISO: string, toISO: string): Holiday[] {
  if (!isISODate(fromISO) || !isISODate(toISO) || toISO < fromISO) return [];
  const firstYear = Number(fromISO.slice(0, 4));
  const lastYear = Number(toISO.slice(0, 4));
  const out: Holiday[] = [];
  for (let y = firstYear; y <= lastYear; y++) {
    for (const h of holidaysForYear(y)) {
      if (h.date >= fromISO && h.date <= toISO) out.push(h);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// True for a real calendar date written as YYYY-MM-DD. Rejects shapes that
// parse but do not exist, like 2026-02-30.
export function isISODate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= daysInMonth(y, m);
}

// Shift a YYYY-MM-DD date by whole months, clamping to the end of the target
// month (Aug 31 + 6 months = Feb 28/29).
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return iso(year, month, Math.min(d, daysInMonth(year, month)));
}
