// Store-hours coverage: does the published schedule put somebody in the store
// for every hour the door is open?
//
// This module is deliberately pure and dependency-free (no supabase, no React,
// no next) so it can be unit tested directly with `node --test`. Callers hand
// it plain rows; it hands back gaps.
//
// Everything here is America/New_York wall-clock. Shifts are stored as UTC
// instants, so the only timezone work is converting an instant to a NY date
// plus a minute-of-day — after that it is integer arithmetic, which is what
// makes the DST weekends behave. On the fall-back day a 00:00–06:00 shift is
// seven real hours but still covers wall-clock 00:00–06:00; on the
// spring-forward day the same shift is five real hours and still covers
// wall-clock 00:00–06:00. Opening hours are written in wall clock, so wall
// clock is the right unit to compare them in.

export const COVERAGE_TZ = "America/New_York";

/** One row of the weekly pattern. weekday: 0 = Sunday … 6 = Saturday. */
export type StoreHoursRow = {
  weekday: number;
  is_closed: boolean;
  opens: string | null;
  closes: string | null;
};

/** A one-off date: a holiday closure or special hours. */
export type StoreHoursException = {
  date: string; // YYYY-MM-DD
  label?: string | null;
  is_closed: boolean;
  opens?: string | null;
  closes?: string | null;
};

/**
 * A stretch of dates the store is shut for, taken from a schedule annotation
 * with business_closed = true. Both ends are inclusive.
 */
export type ClosedDateRange = {
  start_date: string; // YYYY-MM-DD
  end_date: string; // YYYY-MM-DD, inclusive
  title?: string | null;
};

/** Just enough of a shift_types row to decide whether a shift covers. */
export type ShiftTypeCoverage = { name: string; in_store: boolean };

/** Just enough of a shifts row to place it on the clock. */
export type CoverageShift = {
  starts_at: string; // ISO timestamptz
  ends_at: string; // ISO timestamptz
  employee_id: string | null;
  position?: string | null;
};

/** An uncovered stretch inside a day's opening hours. Times are NY "HH:MM". */
export type CoverageGap = { date: string; from: string; to: string };

/** A day in the week whose store hours nobody has set yet. */
export type HoursNotSetDay = { date: string; weekday: number };

export type CoverageResult = {
  gaps: CoverageGap[];
  hoursNotSet: HoursNotSetDay[];
};

/**
 * What the store is doing on a given date.
 *  - "open"   — trading between `opens` and `closes` (minutes past midnight).
 *  - "closed" — shut all day; nothing to cover.
 *  - "unset"  — nobody has told us. Distinct from closed: we cannot judge
 *               coverage, so we nag instead of blocking.
 */
export type OpenWindow =
  | { state: "open"; opens: number; closes: number; source: "weekday" | "exception"; label?: string | null }
  | { state: "closed"; source: "weekday" | "exception" | "annotation"; label?: string | null }
  | { state: "unset" };

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------------------
// Date and time helpers. All date strings are YYYY-MM-DD; all times of day are
// minutes past local midnight (0 … 1440).
// ---------------------------------------------------------------------------

/** Shift a YYYY-MM-DD date string by whole days. */
export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD date string. */
export function weekdayOf(date: string): number {
  return new Date(date + "T00:00:00Z").getUTCDay();
}

/** The seven YYYY-MM-DD dates of the week beginning `weekStart`. */
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/**
 * Postgres `time` ("09:00", "09:00:00", "09:00:00.5") to minutes past midnight.
 * Returns null for anything unparseable, including null itself.
 */
export function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 24 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total > 1440 ? null : total;
}

/** Minutes past midnight back to "HH:MM". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

const NY_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: COVERAGE_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * An instant (ISO string) as New York wall clock: which local date it lands on
 * and how many minutes past local midnight it is. This is the one place the
 * module touches a timezone database.
 */
export function nyWallClock(iso: string): { date: string; minutes: number } {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new Error(`coverage: invalid timestamp ${JSON.stringify(iso)}`);
  const parts = NY_PARTS.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // Some ICU builds render local midnight as hour 24; normalise it to 0.
  const hour = Number(get("hour")) % 24;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
  };
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------

/**
 * Resolve what the store is doing on one date.
 *
 * Precedence, highest first:
 *
 *  1. A "Business closed" schedule annotation covering the date. This wins over
 *     everything, including a store_hours_exceptions row carrying special
 *     hours: if a manager has written "Closed" across the date on the board, we
 *     take them at their word rather than trying to reconcile two sources that
 *     disagree. A date is closed if EITHER the annotation says so OR an
 *     exception row says so. It also beats "hours not set" — an annotated
 *     closure is an answer, so the day is not reported as missing hours.
 *  2. An exception row for that date — closed, or the special hours it carries.
 *  3. The weekday pattern.
 *
 * No weekday row at all means "unset", never "closed". A row that claims to be
 * open but carries unusable times is treated as unset too, because we genuinely
 * do not know the window and guessing would either hide a hole or invent one.
 */
export function resolveOpenWindow(
  date: string,
  storeHours: StoreHoursRow[],
  exceptions: StoreHoursException[],
  closedRanges: ClosedDateRange[] = [],
): OpenWindow {
  const closure = closedRanges.find((r) => r.start_date <= date && date <= r.end_date);
  if (closure) return { state: "closed", source: "annotation", label: closure.title ?? null };

  const exception = exceptions.find((e) => e.date === date);
  if (exception) {
    if (exception.is_closed) return { state: "closed", source: "exception", label: exception.label ?? null };
    const opens = parseTime(exception.opens);
    const closes = parseTime(exception.closes);
    if (opens === null || closes === null || closes <= opens) return { state: "unset" };
    return { state: "open", opens, closes, source: "exception", label: exception.label ?? null };
  }

  const weekday = weekdayOf(date);
  const row = storeHours.find((r) => r.weekday === weekday);
  if (!row) return { state: "unset" };
  if (row.is_closed) return { state: "closed", source: "weekday" };
  const opens = parseTime(row.opens);
  const closes = parseTime(row.closes);
  if (opens === null || closes === null || closes <= opens) return { state: "unset" };
  return { state: "open", opens, closes, source: "weekday" };
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

/**
 * Does this shift put somebody behind the counter?
 *
 * Two conditions: it is assigned to a person (an open shift nobody has taken
 * covers nothing), and its position is an in-store type. A blank or unrecognised
 * position counts as in-store, matching the column's `default true` — an
 * unclassified type must never silently excuse a hole.
 */
export function shiftCovers(shift: CoverageShift, inStoreByName: Map<string, boolean>): boolean {
  if (!shift.employee_id) return false;
  const position = shift.position?.trim();
  if (!position) return true;
  const known = inStoreByName.get(position);
  return known === undefined ? true : known;
}

type DaySegment = { date: string; from: number; to: number };

/**
 * Break a shift into per-NY-date wall-clock segments. A shift that runs past
 * midnight contributes to two dates (or more, though nobody works a 48-hour
 * shift); a shift ending exactly at midnight contributes only to the day it
 * started. A shift that starts before the week and ends inside it therefore
 * still covers the part that lands in the week — the caller just has to hand
 * it in.
 *
 * Known limitation, on the fall-back morning only. 01:00–02:00 happens twice
 * that day, and a wall-clock segment cannot say which pass it means. A shift
 * from 00:00 EDT to 01:30 EST is two and a half real hours but reads here as
 * wall clock 00:00–01:30, so against a 00:00–02:00 window it reports a gap of
 * 01:30–02:00. That gap is real in wall-clock terms — those thirty minutes on
 * the second pass genuinely are unstaffed — but the same segment would be
 * produced by a shift that ended at 01:30 EDT and worked an hour less. The
 * alternative (deriving the end from elapsed minutes when the two offsets
 * differ) trades this for a worse error: it would place that shift's end at
 * wall clock 02:30 and claim cover of an hour nobody worked. Wall clock is the
 * unit opening hours are written in, so wall clock is what we compare. The shop
 * opens late morning, so the ambiguous window is never trading time anyway.
 */
export function shiftSegments(shift: CoverageShift): DaySegment[] {
  const start = nyWallClock(shift.starts_at);
  const end = nyWallClock(shift.ends_at);

  if (end.date < start.date) return []; // ends before it starts: ignore it
  if (end.date === start.date) {
    return end.minutes > start.minutes ? [{ date: start.date, from: start.minutes, to: end.minutes }] : [];
  }

  const segments: DaySegment[] = [{ date: start.date, from: start.minutes, to: 1440 }];
  let cursor = addDays(start.date, 1);
  for (let guard = 0; cursor < end.date && guard < 400; guard++) {
    segments.push({ date: cursor, from: 0, to: 1440 });
    cursor = addDays(cursor, 1);
  }
  if (end.minutes > 0) segments.push({ date: end.date, from: 0, to: end.minutes });
  return segments.filter((s) => s.to > s.from);
}

/** Sort and merge intervals, joining ones that touch as well as ones that overlap. */
function mergeIntervals(intervals: { from: number; to: number }[]): { from: number; to: number }[] {
  const sorted = [...intervals].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: { from: number; to: number }[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.from <= last.to) last.to = Math.max(last.to, interval.to);
    else merged.push({ from: interval.from, to: interval.to });
  }
  return merged;
}

/** The stretches of [opens, closes) that `merged` does not cover. */
function uncovered(opens: number, closes: number, merged: { from: number; to: number }[]) {
  const gaps: { from: number; to: number }[] = [];
  let cursor = opens;
  for (const interval of merged) {
    if (cursor >= closes) break;
    if (interval.to <= cursor) continue;
    if (interval.from >= closes) break;
    if (interval.from > cursor) gaps.push({ from: cursor, to: interval.from });
    cursor = Math.max(cursor, interval.to);
  }
  if (cursor < closes) gaps.push({ from: cursor, to: closes });
  return gaps.filter((g) => g.to > g.from);
}

/**
 * Split a padded query window into the two sets "publish week" needs.
 *
 *  - `publishable` — the drafts this publish will flip live: unpublished, and
 *    starting inside the week in New York. Exactly the set the route has always
 *    published; widening the query window must never widen this.
 *  - `forCoverage` — everything whose New York span touches the week at all,
 *    published or not. Wider on purpose: a shift starting Saturday evening and
 *    running into Sunday morning is not publishable here but is certainly
 *    standing in the store, and a check that could not see it would invent a
 *    gap at Sunday open.
 *
 * Pure, so the distinction can be tested without a database.
 */
export function selectWeekShifts<T extends { starts_at: string; ends_at: string; published?: boolean | null }>(
  shifts: T[],
  weekStart: string,
): { publishable: T[]; forCoverage: T[] } {
  const weekEnd = addDays(weekStart, 7);
  const publishable: T[] = [];
  const forCoverage: T[] = [];
  for (const shift of shifts) {
    const startDate = nyWallClock(shift.starts_at).date;
    const endDate = nyWallClock(shift.ends_at).date;
    if (!shift.published && startDate >= weekStart && startDate < weekEnd) publishable.push(shift);
    if (startDate < weekEnd && endDate >= weekStart) forCoverage.push(shift);
  }
  return { publishable, forCoverage };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Check one week. Returns every uncovered stretch inside opening hours, plus
 * the days whose hours nobody has set (reported, never blocking).
 *
 * `shifts` may contain anything — the caller usually passes a padded query
 * window. Only the seven dates of the week are examined, and only shifts that
 * actually cover (assigned + in-store) count.
 */
export function checkWeekCoverage(input: {
  weekStart: string;
  storeHours: StoreHoursRow[];
  exceptions: StoreHoursException[];
  shiftTypes: ShiftTypeCoverage[];
  shifts: CoverageShift[];
  /** "Business closed" annotations overlapping the week. Optional. */
  closedRanges?: ClosedDateRange[];
}): CoverageResult {
  const { weekStart, storeHours, exceptions, shiftTypes, shifts } = input;
  const closedRanges = input.closedRanges ?? [];
  const inStoreByName = new Map(shiftTypes.map((t) => [t.name, t.in_store]));

  const byDate = new Map<string, { from: number; to: number }[]>();
  for (const shift of shifts) {
    if (!shiftCovers(shift, inStoreByName)) continue;
    for (const segment of shiftSegments(shift)) {
      const list = byDate.get(segment.date);
      if (list) list.push({ from: segment.from, to: segment.to });
      else byDate.set(segment.date, [{ from: segment.from, to: segment.to }]);
    }
  }

  const gaps: CoverageGap[] = [];
  const hoursNotSet: HoursNotSetDay[] = [];

  for (const date of weekDates(weekStart)) {
    const window = resolveOpenWindow(date, storeHours, exceptions, closedRanges);
    if (window.state === "unset") {
      hoursNotSet.push({ date, weekday: weekdayOf(date) });
      continue;
    }
    if (window.state === "closed") continue;
    const merged = mergeIntervals(byDate.get(date) ?? []);
    for (const gap of uncovered(window.opens, window.closes, merged)) {
      gaps.push({ date, from: formatMinutes(gap.from), to: formatMinutes(gap.to) });
    }
  }

  return { gaps, hoursNotSet };
}

// ---------------------------------------------------------------------------
// Plain-words formatting, for the publish dialog. Kept here (rather than in the
// component) because it is pure and worth testing.
// ---------------------------------------------------------------------------

/** "14:00" → "2:00 PM". */
export function formatClock(hhmm: string): string {
  const minutes = parseTime(hhmm);
  if (minutes === null) return hhmm;
  const hour24 = Math.floor(minutes / 60) % 24;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minutes % 60).padStart(2, "0")} ${suffix}`;
}

/** "2026-09-22" → "Tue Sep 22". */
export function formatDayLabel(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return date;
  return `${DAY_NAMES[d.getUTCDay()]} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "Tue Sep 22: nobody in store 2:00 PM to 4:00 PM". */
export function describeGap(gap: CoverageGap): string {
  return `${formatDayLabel(gap.date)}: nobody in store ${formatClock(gap.from)} to ${formatClock(gap.to)}`;
}

/** "Mon, Tue" — the short weekday names of the days whose hours are unset. */
export function describeHoursNotSet(days: HoursNotSetDay[]): string {
  return days.map((d) => DAY_NAMES[d.weekday] ?? d.date).join(", ");
}
