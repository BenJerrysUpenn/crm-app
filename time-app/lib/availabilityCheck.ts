// Does the person on a shift say they can work it?
//
// Every shift assigned to somebody is checked against what that person has put
// on the Availability page for the date(s) the shift lands on. A shift is a
// mismatch when, for any date it touches:
//
//  1. time_off                 — they have approved time off that day, or have
//                                asked for it and the request is still pending;
//  2. unavailable_overlap      — part of the shift falls in a block they marked
//                                "can't work";
//  3. outside_available_hours  — they have given hours for that day, and part of
//                                the shift falls outside all of them;
//  4. no_availability          — they have given no hours at all for that day.
//                                Deliberately its own kind: it means "we don't
//                                know", not "they said no", and the board shows
//                                it under its own heading.
//
// Open shifts are never checked (nobody to ask). Every shift type is checked,
// catering included.
//
// This is the one definition of "is this person available for this shift".
// Auto-fill uses it to pick candidates, and the create/edit routes use it to
// ask before saving. The whole-week helpers below check a full set of shifts at
// once.
//
// Pure and dependency-free like lib/coverage.ts, so `node --test` runs it.
//
// ---------------------------------------------------------------------------
// How availability rows resolve to "what does this person say about date D"
// ---------------------------------------------------------------------------
//
// An availability row is either weekly (weekday set, repeats every week) or for
// one date (specific_date set). Both kinds hold blocks of three sorts —
// available, preferred, unavailable ("can't work"). A block with no times is
// all day. A block whose end is at or before its start runs past midnight.
//
// The day is painted in four layers, each drawn over the one before:
//
//     weekly can-work  <  weekly can't-work  <  date can-work  <  date can't-work
//
// So an entry for the specific date beats the weekly pattern wherever the two
// overlap, and within the same layer "can't work" beats "can work". Where they
// do not overlap both stand: a one-off "can't work 6–8pm" on a Tuesday does not
// wipe out the weekly "prefer 12–5pm" Tuesday, which matches how the
// Availability calendar shows the two chips side by side.
//
// Time off (is_available = false on a date) sits above all of it and covers the
// whole day. Approved and pending requests both count; a denied one is ignored.
// A weekly row with is_available = false is read as an all-week "can't work"
// block, since time off is only ever requested for dates.
//
// Rows with status "denied" are ignored whatever they say.
//
// A weekly row only speaks for dates on or after the day it was created (its
// created_at, read as a New York calendar date). Setting "can't work Sundays"
// today says nothing about last Sunday, which may already have been worked.
// A block spilling past midnight from the day before is judged by that day.
// A row with no created_at applies to every date. Dated rows are unaffected.
//
// Everything is America/New_York wall clock, via lib/coverage.ts.

import {
  addDays,
  formatClock,
  formatDayLabel,
  formatMinutes,
  mergeIntervals,
  nyWallClock,
  parseTime,
  shiftSegments,
  uncovered,
  weekdayOf,
} from "./coverage.ts";

/** Just enough of an availability row to judge a shift by. */
export type AvailabilityRow = {
  employee_id: string;
  weekday: number | null;
  specific_date: string | null;
  start_time: string | null;
  end_time: string | null;
  is_available: boolean;
  status?: "pending" | "approved" | "denied" | string | null;
  preference?: "available" | "preferred" | "unavailable" | string | null;
  /** When the row was written. A weekly row does not apply before this date (New York). */
  created_at?: string | null;
};

/** Just enough of a shift to place it on the clock and name it. */
export type ShiftForAvailability = {
  id?: number | null;
  employee_id: string | null;
  position?: string | null;
  starts_at: string;
  ends_at: string;
};

type Interval = { from: number; to: number };

export type AvailabilityReason =
  | { kind: "time_off"; date: string; status: "approved" | "pending" }
  | { kind: "unavailable_overlap"; date: string; from: string; to: string }
  | { kind: "outside_available_hours"; date: string; from: string; to: string }
  | { kind: "no_availability"; date: string };

export type AvailabilityReasonKind = AvailabilityReason["kind"];

/** What one person has said about one date, in plain words, for the dialogs. */
export type DaySummary = { date: string; summary: string };

export type AvailabilityMismatch = {
  shift_id: number | null;
  employee_id: string;
  position: string | null;
  starts_at: string;
  ends_at: string;
  reasons: AvailabilityReason[];
  /** The person's availability on each date the shift touches. */
  days: DaySummary[];
};

// ---------------------------------------------------------------------------
// Resolving one day
// ---------------------------------------------------------------------------

export type Kind = "available" | "preferred" | "unavailable";
/** A stretch of the day and what it is. `source` says whether a dated entry or the weekly pattern put it there. */
export type Painted = { from: number; to: number; kind: Kind; source: "weekly" | "date" };

/** A resolved day: what each minute of it is, on that date's own 0–1440 axis. */
export type ResolvedDay = {
  date: string;
  timeOff: "approved" | "pending" | null;
  /** Non-overlapping, sorted. Minutes nobody said anything about are absent. */
  blocks: Painted[];
};

function kindOf(row: AvailabilityRow): Kind {
  if (!row.is_available) return "unavailable";
  if (row.preference === "unavailable") return "unavailable";
  if (row.preference === "preferred") return "preferred";
  return "available";
}

/**
 * The New York calendar date a row was created on, or null when it has no
 * readable created_at (such a row applies to every date).
 */
function createdOn(row: AvailabilityRow): string | null {
  if (!row.created_at) return null;
  try {
    return nyWallClock(row.created_at).date;
  } catch {
    return null;
  }
}

/**
 * A row's block on its own date's axis. May run past 1440 when the block
 * crosses midnight. Null for a block whose times cannot be read.
 */
function rowInterval(row: AvailabilityRow): Interval | null {
  if (!row.start_time && !row.end_time) return { from: 0, to: 1440 };
  const from = row.start_time ? parseTime(row.start_time) : 0;
  const to = row.end_time ? parseTime(row.end_time) : 1440;
  if (from === null || to === null) return null;
  if (to > from) return { from, to };
  // "18:00–02:00", or "18:00–00:00": the end is the next morning.
  return { from, to: to + 1440 };
}

/** Paint `kind` over [from, to), replacing whatever was there. */
function paint(blocks: Painted[], from: number, to: number, kind: Kind, source: Painted["source"]): Painted[] {
  if (to <= from) return blocks;
  const out: Painted[] = [];
  for (const b of blocks) {
    if (b.to <= from || b.from >= to) {
      out.push(b);
      continue;
    }
    if (b.from < from) out.push({ ...b, to: from });
    if (b.to > to) out.push({ ...b, from: to });
  }
  out.push({ from, to, kind, source });
  out.sort((a, b) => a.from - b.from);
  // Join touching blocks of the same kind so summaries read "9 AM to 5 PM",
  // not "9 AM to 1 PM, 1 PM to 5 PM".
  const joined: Painted[] = [];
  for (const b of out) {
    const last = joined[joined.length - 1];
    if (last && last.kind === b.kind && last.source === b.source && last.to === b.from) last.to = b.to;
    else joined.push({ ...b });
  }
  return joined;
}

/**
 * What `employeeId` says about `date`. `rows` may hold anyone's rows for any
 * dates; only the ones that bear on this person and this date are used. A
 * block from the day before that runs past midnight counts on this date.
 */
export function resolveDay(employeeId: string, date: string, rows: AvailabilityRow[]): ResolvedDay {
  const weekday = weekdayOf(date);
  const prevDate = addDays(date, -1);
  const prevWeekday = weekdayOf(prevDate);

  let timeOff: ResolvedDay["timeOff"] = null;
  // [layer, from, to, kind], on this date's axis.
  const layered: { layer: number; from: number; to: number; kind: Kind; source: Painted["source"] }[] = [];

  for (const row of rows) {
    if (row.employee_id !== employeeId) continue;
    if (row.status === "denied") continue;

    const isDated = row.specific_date !== null && row.specific_date !== undefined;
    // Time off: a dated row that says "not available". Whole day, whatever
    // times it carries — the request form never sets any.
    if (isDated && !row.is_available) {
      if (row.specific_date === date) {
        const status = row.status === "pending" ? "pending" : "approved";
        if (timeOff !== "approved") timeOff = status;
      }
      continue;
    }

    let offset: number | null = null;
    if (isDated) {
      if (row.specific_date === date) offset = 0;
      else if (row.specific_date === prevDate) offset = -1440;
    } else if (row.weekday !== null && row.weekday !== undefined) {
      if (row.weekday === weekday) offset = 0;
      else if (row.weekday === prevWeekday) offset = -1440;
      // Not in force yet on the date the block belongs to.
      const since = offset === null ? null : createdOn(row);
      if (since !== null && (offset === 0 ? date : prevDate) < since) offset = null;
    }
    if (offset === null) continue;

    const interval = rowInterval(row);
    if (!interval) continue;
    const from = Math.max(0, interval.from + offset);
    const to = Math.min(1440, interval.to + offset);
    if (to <= from) continue;

    const kind = kindOf(row);
    const canWork = kind !== "unavailable";
    const layer = (isDated ? 2 : 0) + (canWork ? 0 : 1);
    layered.push({ layer, from, to, kind, source: isDated ? "date" : "weekly" });
  }

  // Within a layer, "preferred" is painted over "available" so a stretch that
  // is both reads as preferred.
  layered.sort((a, b) => a.layer - b.layer || (a.kind === "preferred" ? 1 : 0) - (b.kind === "preferred" ? 1 : 0));
  let blocks: Painted[] = [];
  for (const l of layered) blocks = paint(blocks, l.from, l.to, l.kind, l.source);

  return { date, timeOff, blocks };
}

// ---------------------------------------------------------------------------
// Checking a shift
// ---------------------------------------------------------------------------

function intervalsOf(day: ResolvedDay, kinds: Kind[]): Interval[] {
  return mergeIntervals(day.blocks.filter((b) => kinds.includes(b.kind)).map((b) => ({ from: b.from, to: b.to })));
}

function overlapsOf(from: number, to: number, intervals: Interval[]): Interval[] {
  return intervals
    .map((i) => ({ from: Math.max(from, i.from), to: Math.min(to, i.to) }))
    .filter((i) => i.to > i.from);
}

/**
 * Check one shift. Null when it is open, unreadable, or the person is
 * available for all of it.
 */
export function checkShiftAvailability(
  shift: ShiftForAvailability,
  rows: AvailabilityRow[],
): AvailabilityMismatch | null {
  if (!shift.employee_id) return null;
  const employeeId = shift.employee_id;
  let segments: ReturnType<typeof shiftSegments>;
  try {
    segments = shiftSegments({ starts_at: shift.starts_at, ends_at: shift.ends_at, employee_id: employeeId });
  } catch {
    return null; // an unparseable timestamp is the save route's 400, not ours
  }
  if (segments.length === 0) return null;

  const reasons: AvailabilityReason[] = [];
  const days: DaySummary[] = [];

  for (const segment of segments) {
    const day = resolveDay(employeeId, segment.date, rows);
    days.push({ date: segment.date, summary: summariseDay(day) });

    if (day.timeOff) {
      reasons.push({ kind: "time_off", date: segment.date, status: day.timeOff });
      continue;
    }

    const cantWork = overlapsOf(segment.from, segment.to, intervalsOf(day, ["unavailable"]));
    for (const o of cantWork) {
      reasons.push({ kind: "unavailable_overlap", date: segment.date, from: formatMinutes(o.from), to: formatMinutes(o.to) });
    }

    // What is left once the "can't work" stretches are accounted for.
    const rest = uncovered(segment.from, segment.to, cantWork);
    if (rest.length === 0) continue;

    const canWork = intervalsOf(day, ["available", "preferred"]);
    if (canWork.length === 0) {
      reasons.push({ kind: "no_availability", date: segment.date });
      continue;
    }
    for (const r of rest) {
      for (const gap of uncovered(r.from, r.to, canWork)) {
        reasons.push({
          kind: "outside_available_hours",
          date: segment.date,
          from: formatMinutes(gap.from),
          to: formatMinutes(gap.to),
        });
      }
    }
  }

  if (reasons.length === 0) return null;
  // Read in clock order: by date, then by where in the day the stretch starts
  // (a whole-day reason first).
  const at = (r: AvailabilityReason) => ("from" in r ? r.from : "");
  reasons.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
  return {
    shift_id: shift.id ?? null,
    employee_id: employeeId,
    position: shift.position ?? null,
    starts_at: shift.starts_at,
    ends_at: shift.ends_at,
    reasons,
    days,
  };
}

/**
 * The inclusive range of dated availability rows a check of these shifts needs:
 * the day before the earliest start (an overnight block from that evening can
 * reach into the shift) through the date of the latest end. Null for no
 * readable shifts. Weekly rows are always needed on top of this range.
 */
export function availabilityDateRange(shifts: { starts_at: string; ends_at: string }[]): { from: string; to: string } | null {
  let from: string | null = null;
  let to: string | null = null;
  for (const s of shifts) {
    let start: string;
    let end: string;
    try {
      start = nyWallClock(s.starts_at).date;
      end = nyWallClock(s.ends_at).date;
    } catch {
      continue;
    }
    if (from === null || start < from) from = start;
    if (to === null || end > to) to = end;
  }
  if (from === null || to === null) return null;
  return { from: addDays(from, -1), to: to < from ? from : to };
}

/** Every mismatched shift in the list, in the order given. Open shifts are skipped. */
export function findAvailabilityMismatches(
  shifts: ShiftForAvailability[],
  rows: AvailabilityRow[],
): AvailabilityMismatch[] {
  const out: AvailabilityMismatch[] = [];
  for (const shift of shifts) {
    const m = checkShiftAvailability(shift, rows);
    if (m) out.push(m);
  }
  return out;
}

/**
 * True when every minute of the shift sits in a block the person marked
 * "preferred". Auto-fill ranks these candidates first.
 */
export function prefersShift(shift: ShiftForAvailability, rows: AvailabilityRow[]): boolean {
  if (!shift.employee_id) return false;
  let segments: ReturnType<typeof shiftSegments>;
  try {
    segments = shiftSegments({ starts_at: shift.starts_at, ends_at: shift.ends_at, employee_id: shift.employee_id });
  } catch {
    return false;
  }
  if (segments.length === 0) return false;
  return segments.every((s) => {
    const day = resolveDay(shift.employee_id!, s.date, rows);
    if (day.timeOff) return false;
    return uncovered(s.from, s.to, intervalsOf(day, ["preferred"])).length === 0;
  });
}

/** Mismatches split for a week-at-once check: real conflicts, and "nothing on file". */
export function groupMismatches(mismatches: AvailabilityMismatch[]): {
  conflicts: AvailabilityMismatch[];
  noAvailability: AvailabilityMismatch[];
} {
  const conflicts: AvailabilityMismatch[] = [];
  const noAvailability: AvailabilityMismatch[] = [];
  for (const m of mismatches) {
    if (m.reasons.every((r) => r.kind === "no_availability")) noAvailability.push(m);
    else conflicts.push(m);
  }
  return { conflicts, noAvailability };
}

// ---------------------------------------------------------------------------
// Plain words, for the dialogs. Pure, so tested here rather than in React.
// ---------------------------------------------------------------------------

const KIND_WORDS: Record<Kind, string> = {
  preferred: "prefers",
  available: "available",
  unavailable: "can't work",
};

/** "9:00 AM to 5:00 PM", or "all day". */
export function formatSpan(from: number, to: number): string {
  if (from === 0 && to === 1440) return "all day";
  return `${formatClock(formatMinutes(from))} to ${formatClock(formatMinutes(to))}`;
}

/**
 * "prefers 12:00 PM to 5:00 PM; can't work 6:00 PM to 8:00 PM", or
 * "time off (approved)", or "nothing on file".
 */
export function summariseDay(day: ResolvedDay): string {
  if (day.timeOff) return day.timeOff === "approved" ? "time off (approved)" : "time-off request pending";
  if (day.blocks.length === 0) return "nothing on file";
  const parts: string[] = [];
  for (const kind of ["preferred", "available", "unavailable"] as Kind[]) {
    const mine = mergeIntervals(day.blocks.filter((b) => b.kind === kind));
    if (mine.length) parts.push(`${KIND_WORDS[kind]} ${mine.map((b) => formatSpan(b.from, b.to)).join(", ")}`);
  }
  return parts.join("; ");
}

/** One reason in words. */
export function describeReason(reason: AvailabilityReason): string {
  const day = formatDayLabel(reason.date);
  switch (reason.kind) {
    case "time_off":
      return reason.status === "approved" ? `has approved time off ${day}` : `time-off request pending for ${day} (decide it on the Team tab)`;
    case "unavailable_overlap":
      return `marked can't work ${formatClock(reason.from)} to ${formatClock(reason.to)} on ${day}`;
    case "outside_available_hours":
      return `not available ${formatClock(reason.from)} to ${formatClock(reason.to)} on ${day}`;
    case "no_availability":
      return `no availability on file for ${day}`;
  }
}

/** "Tue Sep 29, 5:00 PM to 10:00 PM", or across midnight "Tue Sep 29, 6:00 PM to Wed Sep 30, 2:00 AM". */
export function describeShiftTime(startsAt: string, endsAt: string): string {
  const segs = shiftSegmentsSafe(startsAt, endsAt);
  const first = segs[0];
  if (!first) return `${startsAt} to ${endsAt}`;
  const last = segs[segs.length - 1];
  const start = `${formatDayLabel(first.date)}, ${formatClock(formatMinutes(first.from))}`;
  if (segs.length === 1) return `${start} to ${formatClock(formatMinutes(first.to))}`;
  return `${start} to ${formatDayLabel(last.date)}, ${formatClock(formatMinutes(last.to))}`;
}

function shiftSegmentsSafe(startsAt: string, endsAt: string) {
  try {
    return shiftSegments({ starts_at: startsAt, ends_at: endsAt, employee_id: "x" });
  } catch {
    return [];
  }
}

/**
 * One line for a week-at-once check:
 * "Sam Lee, Catering Tue Sep 29, 5:00 PM to 10:00 PM: not available 5:00 PM to
 * 10:00 PM on Tue Sep 29 (availability: prefers 12:00 PM to 5:00 PM)".
 */
export function describeMismatch(m: AvailabilityMismatch, name: string | null | undefined): string {
  const who = name?.trim() || "Someone";
  const what = m.position ? `${m.position} ` : "";
  const why = m.reasons.map(describeReason).join("; ");
  // The day's availability adds nothing when the reason already is the whole
  // story: nothing on file, or time off.
  const onFile = m.reasons.every((r) => r.kind === "no_availability" || r.kind === "time_off")
    ? ""
    : ` (availability: ${m.days.map((d) => (m.days.length > 1 ? `${formatDayLabel(d.date)} ${d.summary}` : d.summary)).join("; ")})`;
  return `${who}, ${what}${describeShiftTime(m.starts_at, m.ends_at)}: ${why}${onFile}`;
}

/**
 * The save-time confirm, as a heading and body lines. `no_availability` alone
 * gets its own softer wording: nothing says they can't, nothing says they can.
 */
export function describeForSave(
  m: AvailabilityMismatch,
  name: string | null | undefined,
): { title: string; lines: string[] } {
  const who = name?.trim() || "This person";
  const when = describeShiftTime(m.starts_at, m.ends_at);
  const onlyNoneOnFile = m.reasons.every((r) => r.kind === "no_availability");
  const availability = m.days.map((d) =>
    m.days.length > 1 ? `Availability ${formatDayLabel(d.date)}: ${d.summary}` : `Availability that day: ${d.summary}`,
  );
  if (onlyNoneOnFile) {
    return {
      title: `${who} has no availability on file`,
      lines: [`Shift: ${when}`, ...availability, `They haven't said whether they can work this. Save anyway?`],
    };
  }
  return {
    title: `${who} isn't available for all of this shift`,
    lines: [`Shift: ${when}`, ...availability, ...m.reasons.map((r) => `• ${capitalise(describeReason(r))}`), "Save anyway?"],
  };
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
