// The Catering event on a shift, as the schedule works it out (Alina,
// 2026-11-02). Adding a shift on the Schedule page is the main way catering
// crew get scheduled, and shifts.deal_id is what ties a shift to its event.
//
// A manager links a shift to an event in the shift popup, one shift at a time.
// When a Catering shift with a person has no link and an event it fits, a badge
// on the schedule says so. The badge is worked out here each time the schedule
// loads and never writes anything. "Fits" is the covers-the-whole-event rule in
// lib/handPlacedCrew.ts; this file has no second one.
//
// Pure, so `node --test` runs it and the browser can use it. The writing side is
// lib/shiftEventLink.ts.

import { formatClock, nyWallClock, parseTime } from "./coverage";
import { eventSpan, isHandPlacedShift, shiftSpan, spanCovers, type CrewShift } from "./handPlacedCrew";

/**
 * The deal stages a shift can be linked at: an event that is happening. The same
 * list as ALERT_STAGES in root lib/coverageReminder.ts; the two apps cannot share
 * a constant in that direction, so change them together.
 */
export const EVENT_STAGES = ["Booked Unpaid", "Booked Paid", "Closed Marketing Event"];

/** The deal columns the schedule reads, and nothing else. */
export const EVENT_DEAL_COLUMNS = "id, event_name, company, venue_name, event_date, event_start_time, event_end_time, stage, archived";

export type EventDeal = {
  id: number;
  event_name?: string | null;
  company?: string | null;
  venue_name?: string | null;
  event_date: string | null;
  event_start_time: string | null;
  event_end_time: string | null;
  stage: string | null;
  archived: number | null;
};

export type ScheduleEvent = {
  id: number;
  name: string;
  event_date: string;
  event_start_time: string | null;
  event_end_time: string | null;
};

/** Can a shift be linked to this deal? */
export function isLinkableDeal(deal: Pick<EventDeal, "stage" | "archived">): boolean {
  return EVENT_STAGES.includes(deal.stage ?? "") && deal.archived === 0;
}

/** A deal as the schedule shows it. Null when it has no date to sit on. */
export function toScheduleEvent(deal: EventDeal): ScheduleEvent | null {
  const date = deal.event_date?.slice(0, 10);
  if (!date) return null;
  const name = [deal.event_name, deal.company, deal.venue_name].map((n) => n?.trim()).find(Boolean);
  return {
    id: deal.id,
    name: name || "Catering event",
    event_date: date,
    event_start_time: deal.event_start_time,
    event_end_time: deal.event_end_time,
  };
}

/** "6:00 PM–9:00 PM", "6:00 PM", or "time not set". */
export function eventTimeText(event: ScheduleEvent): string {
  if (!event.event_start_time) return "time not set";
  const start = formatClock(event.event_start_time);
  return event.event_end_time ? `${start}–${formatClock(event.event_end_time)}` : start;
}

/** What the dropdown shows for an event. */
export function eventOptionLabel(event: ScheduleEvent): string {
  return `${event.name} · ${eventTimeText(event)}`;
}

/** The New York date an instant falls on, or null when it is not a real time. */
export function shiftDate(iso: string): string | null {
  return Number.isNaN(new Date(iso).getTime()) ? null : nyWallClock(iso).date;
}

/** The events on one New York date, earliest first; no time set goes last. */
export function eventsOnDate(events: ScheduleEvent[], date: string): ScheduleEvent[] {
  return events
    .filter((e) => e.event_date === date)
    .sort((a, b) => (parseTime(a.event_start_time) ?? Infinity) - (parseTime(b.event_start_time) ?? Infinity) || a.id - b.id);
}

/**
 * The events on the shift's New York date that it covers from start to finish.
 * An event with no start time cannot be judged, so it never fits; it can still
 * be picked by hand.
 */
export function fittingEvents(shift: Pick<CrewShift, "starts_at" | "ends_at">, events: ScheduleEvent[]): ScheduleEvent[] {
  const date = shiftDate(shift.starts_at);
  if (date === null || shiftDate(shift.ends_at) === null) return [];
  const span = shiftSpan(shift);
  return eventsOnDate(events, date).filter((event) => {
    const needed = eventSpan(event);
    return needed !== null && spanCovers(span, needed);
  });
}

/** Nobody has touched the dropdown (null), or they chose None or an event. */
export type EventPick = number | "none" | null;

/**
 * What the dropdown holds right now.
 *
 * Someone's own choice comes first, while it is still on the shift's date. Then
 * the event the shift is already linked to, unless it is on another day: a shift
 * moved off its event's date must not stay pointing at it. Then the one event
 * that fits, if exactly one does. Two or more is the manager's call, and so is
 * none, so both start at None.
 */
export function selectedEventId(input: {
  pick: EventPick;
  currentDealId: number | null;
  /** The linked deal as read, at any stage. Null when there is none or it is gone. */
  currentEvent: ScheduleEvent | null;
  date: string;
  onDate: ScheduleEvent[];
  fitting: ScheduleEvent[];
}): number | null {
  if (input.pick === "none") return null;
  if (typeof input.pick === "number" && input.onDate.some((e) => e.id === input.pick)) return input.pick;
  if (input.currentDealId !== null && input.currentEvent?.event_date === input.date) return input.currentDealId;
  return input.fitting.length === 1 ? input.fitting[0].id : null;
}

/** A shift as the badge reads it. A row can come back without deal_id. */
export type BadgeShift = Omit<CrewShift, "deal_id"> & { deal_id?: number | null };

export type EventBadge =
  | { kind: "suggest"; event: ScheduleEvent }
  | { kind: "choose"; events: ScheduleEvent[] };

/**
 * The badge on a shift: a Catering shift with a person and no link that fits at
 * least one event. It judges the shift alone. Whether a colleague on the same
 * event is already linked changes nothing, so the rest of a crew stays badged
 * until each of them is done.
 */
export function eventBadge(shift: BadgeShift, events: ScheduleEvent[]): EventBadge | null {
  if (!isHandPlacedShift({ ...shift, deal_id: shift.deal_id ?? null })) return null;
  const fits = fittingEvents(shift, events);
  if (fits.length === 0) return null;
  return fits.length === 1 ? { kind: "suggest", event: fits[0] } : { kind: "choose", events: fits };
}

/** Every badged shift's badge, by shift id. Its size is the count on the button. */
export function eventBadges<T extends BadgeShift & { id: number }>(shifts: T[], events: ScheduleEvent[]): Map<number, EventBadge> {
  const badges = new Map<number, EventBadge>();
  for (const shift of shifts) {
    const badge = eventBadge(shift, events);
    if (badge) badges.set(shift.id, badge);
  }
  return badges;
}

/** What the badge says. */
export function eventBadgeText(badge: EventBadge): string {
  return badge.kind === "suggest" ? `Event: ${badge.event.name}?` : "Choose an event";
}
