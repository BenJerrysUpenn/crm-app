import { addDays, nyWallClock, parseTime } from "./coverage";

// Crew a manager placed by hand: a published Catering shift with a person and
// no deal_id. This is the one rule for whether such a shift covers a catering
// event. The noon reminder (root lib/coverageReminder.ts), the shift reconciler
// (root lib/cateringShifts.ts) and the schedule's Catering event selector
// (lib/scheduleEvents.ts) all judge through it, so they cannot disagree.
//
// It lives here because shared rules are reached one way in this repo: the root
// app imports from time-app/lib by relative path, as lib/coverageReminder.ts
// does with coverage.ts. The time app is deployed from its own folder and never
// imports out of it. Root lib/handPlacedCrew.ts re-exports this file. The root
// tsconfig has no allowImportingTsExtensions, so the import above stays
// extensionless.
//
// Pure: rows in, answers out.

export const CATERING_POSITION = "Catering";

/** Is this a Catering shift's position? Surrounding spaces do not count. */
export function isCateringPosition(position: unknown): boolean {
  return typeof position === "string" && position.trim() === CATERING_POSITION;
}

/** A shift as this rule reads it. */
export type CrewShift = {
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  position?: string | null;
  published: boolean;
  deal_id: number | null;
};

/** The times of a catering event, as they sit on a deal: "HH:MM" text. */
export type EventTimes = {
  event_date: string;
  event_start_time?: string | null;
  event_end_time?: string | null;
};

/** A stretch of New York wall-clock time, as minutes that compare across days. */
export type Span = { from: number; to: number };

/**
 * A New York date and minute of the day as one number, so moments on different
 * days compare. Wall clock for the reason time-app/lib/coverage.ts gives: event
 * times are written in it, and it needs no offset arithmetic on the days the
 * clocks change.
 */
function wallMinute(date: string, minutes: number): number {
  return Date.parse(`${date}T00:00:00Z`) / 60000 + minutes;
}

/**
 * The stretch of time a shift has to span to cover this event, or null when it
 * has no start time and cannot be judged. An end earlier than the start is the
 * next morning. With no end time, the shift has to run past the start.
 */
export function eventSpan(event: EventTimes): Span | null {
  const starts = parseTime(event.event_start_time);
  if (starts === null) return null;
  const from = wallMinute(event.event_date, starts);
  const ends = parseTime(event.event_end_time);
  if (ends === null) return { from, to: from + 1 };
  return { from, to: wallMinute(event.event_date, ends) + (ends < starts ? 1440 : 0) };
}

/**
 * Is this a shift a manager placed by hand? Published, a person on it, linked to
 * no deal, position Catering. A shift linked to any deal never counts.
 */
export function isHandPlacedShift(shift: CrewShift): boolean {
  return (
    shift.published &&
    !!shift.employee_id &&
    shift.deal_id === null &&
    isCateringPosition(shift.position)
  );
}

/** A shift's New York wall-clock time as a Span. Throws on a bad timestamp. */
export function shiftSpan(shift: Pick<CrewShift, "starts_at" | "ends_at">): Span {
  const start = nyWallClock(shift.starts_at);
  const end = nyWallClock(shift.ends_at);
  return { from: wallMinute(start.date, start.minutes), to: wallMinute(end.date, end.minutes) };
}

/** Does the shift span the whole event? A partial overlap does not. */
export function spanCovers(shift: Span, event: Span): boolean {
  return shift.from <= event.from && shift.to >= event.to;
}

/**
 * The distinct people on hand-placed shifts covering this event.
 *
 * Per event, deliberately: this does not allocate one shift across overlapping
 * events the way the reminder's coveredByHandPlacedShifts does, so one person
 * on a shift spanning two overlapping events counts on both.
 */
export function handPlacedCrewCovering(event: Span, shifts: CrewShift[]): number {
  const people = new Set<string>();
  for (const shift of shifts) {
    if (isHandPlacedShift(shift) && spanCovers(shiftSpan(shift), event)) people.add(shift.employee_id!);
  }
  return people.size;
}

/**
 * The instants to read shifts for, around an event on this date. Any shift that
 * covers the event is on the clock at its start, and that start falls somewhere
 * in the UTC days date-1 to date+1 whatever the New York offset. The rule above
 * judges what comes back; the range only keeps the read small.
 */
export function eventReadRange(eventDate: string): { fromISO: string; toISO: string } {
  return {
    fromISO: `${addDays(eventDate, -1)}T00:00:00Z`,
    toISO: `${addDays(eventDate, 2)}T00:00:00Z`,
  };
}
