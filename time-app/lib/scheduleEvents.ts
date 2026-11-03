// The event on a shift, as the schedule works it out (Alina, 2026-11-02). Adding a
// shift on the Schedule page is the main way crew get scheduled, and
// shifts.deal_id is what ties a shift to its event.
//
// The position says which events: a Catering shift takes a booked catering event,
// a Marketing shift its marketing event, and any other position none. Both also take
// a finished one of their own kind, so a person left unlinked when an event ended
// can still be linked by a manager, and payroll reads that link.
//
// A manager links a shift to an event in the shift popup, one shift at a time.
// The popup chooses the one event that fits by itself only when it was opened to
// choose one (a badge or the "Events to choose" list) or for a new shift; opened
// any other way it suggests that event and leaves the dropdown on None.
// When such a shift with a person has no link and an event it fits, a badge on
// the schedule says so. The badge is worked out here each time the schedule loads
// and never writes anything. "Fits" is the covers-the-whole-event rule in
// lib/handPlacedCrew.ts; this file has no second one.
//
// Pure, so `node --test` runs it and the browser can use it. The writing side is
// lib/shiftEventLink.ts.

import { addDays, formatClock, nyWallClock, parseTime } from "./coverage";
import { eventSpan, isCateringPosition, isUnlinkedStaffedShift, shiftSpan, spanCovers, type CrewShift } from "./handPlacedCrew";

/** The word lib/payroll/verify.ts reads as a Marketing shift. */
export const MARKETING_POSITION = "Marketing";

export type EventKind = "catering" | "marketing";

/**
 * The deal stages each kind of shift can be linked at while the event is still to
 * come. A shift already linked to a deal at another stage keeps that link: see
 * eventDropdown.
 */
const STAGES_BY_KIND: Record<EventKind, string[]> = {
  catering: ["Booked Unpaid", "Booked Paid"],
  marketing: ["Closed Marketing Event"],
};

/** The stage an event of either kind ends at, so it says nothing about the kind. */
export const FINISHED_STAGE = "Event Complete";

/**
 * A finished event puts a badge on a shift for this many days after its date. The
 * dropdown has no such limit: it lists one date's events, and a manager has opened
 * that shift on purpose.
 */
export const FINISHED_BADGE_DAYS = 14;

/** Every stage a schedule read needs. eventsForPosition then splits them by position. */
export const EVENT_STAGES = [...STAGES_BY_KIND.catering, ...STAGES_BY_KIND.marketing, FINISHED_STAGE];

/** Both kinds: what a finished event is listed for when it can't be told which it was. */
const EITHER_KIND: EventKind[] = ["catering", "marketing"];

/** Which events this position takes; null for one with no dropdown and no badge. Surrounding spaces do not count. */
export function eventKindOf(position: unknown): EventKind | null {
  if (isCateringPosition(position)) return "catering";
  return typeof position === "string" && position.trim() === MARKETING_POSITION ? "marketing" : null;
}

/** What the popup calls the dropdown for this position. */
export function eventFieldLabel(position: unknown): string {
  return eventKindOf(position) === "marketing" ? "Marketing event" : "Catering event";
}

/** The deal columns the schedule reads, and nothing else. */
export const EVENT_DEAL_COLUMNS = "id, event_name, company, venue_name, event_date, event_start_time, event_end_time, stage, archived, event_type";

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
  event_type?: string | null;
};

/** The deal columns a linked shift's chip name comes from, and nothing else. */
export const EVENT_NAME_COLUMNS = "id, company, contact_first_name, contact_last_name";

export type EventNameDeal = {
  id: number;
  company?: string | null;
  contact_first_name?: string | null;
  contact_last_name?: string | null;
};

export type ScheduleEvent = {
  id: number;
  name: string;
  stage: string | null;
  event_date: string;
  event_start_time: string | null;
  event_end_time: string | null;
  /**
   * Which kinds of shift a finished event is for, as lib/shiftEventLink.ts works it
   * out from the shifts linked to it. Only a finished event has this. Absent on one
   * means it can't be told, so it is listed for both.
   */
  finished_for?: EventKind[];
};

/** Does a shift of this kind take this event, going by its stage and, once it is finished, what it was? */
function takesEvent(kind: EventKind, event: Pick<ScheduleEvent, "stage" | "finished_for">): boolean {
  if (event.stage === FINISHED_STAGE) return (event.finished_for ?? EITHER_KIND).includes(kind);
  return STAGES_BY_KIND[kind].includes(event.stage ?? "");
}

/** Can a shift at this position be linked to this deal? */
export function isLinkableDeal(deal: Pick<EventDeal, "stage" | "archived"> & Pick<ScheduleEvent, "finished_for">, position: unknown): boolean {
  const kind = eventKindOf(position);
  return kind !== null && takesEvent(kind, deal) && deal.archived === 0;
}

/** The events a shift at this position can be offered. */
export function eventsForPosition(position: unknown, events: ScheduleEvent[]): ScheduleEvent[] {
  const kind = eventKindOf(position);
  return kind === null ? [] : events.filter((e) => takesEvent(kind, e));
}

/** A deal as the schedule shows it. Null when it has no date to sit on. */
export function toScheduleEvent(deal: EventDeal, finishedFor?: EventKind[]): ScheduleEvent | null {
  const date = deal.event_date?.slice(0, 10);
  if (!date) return null;
  const name = [deal.event_name, deal.company, deal.venue_name].map((n) => n?.trim()).find(Boolean);
  return {
    id: deal.id,
    name: name || "Catering event",
    stage: deal.stage,
    event_date: date,
    event_start_time: deal.event_start_time,
    event_end_time: deal.event_end_time,
    ...(finishedFor ? { finished_for: finishedFor } : {}),
  };
}

/** The name on a linked shift's chip: the company, else the contact. Null when a deal has neither. */
export function eventChipName(deal: EventNameDeal): string | null {
  const contact = [deal.contact_first_name, deal.contact_last_name].map((n) => n?.trim()).filter(Boolean).join(" ");
  return deal.company?.trim() || contact || null;
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

/** What the popup knows about a shift when it works out its event dropdown. */
export type DropdownInput = {
  pick: EventPick;
  currentDealId: number | null;
  /** The linked deal as read, at any stage. Null when there is none or it is gone. */
  currentEvent: ScheduleEvent | null;
  /** The date the shift is saved on. Absent on a new shift. */
  savedDate?: string | null;
  date: string;
  onDate: ScheduleEvent[];
  fitting: ScheduleEvent[];
  /**
   * May the popup choose the one event that fits by itself? True when it was opened
   * from a badge or the "Events to choose" list, or for a new shift. False when an
   * existing shift was opened any other way, perhaps to fix its hours: every save
   * writes what the dropdown holds, and payroll reads a link as who was on the crew,
   * so a link has to be someone's choice.
   */
  preselect: boolean;
};

/** The part of DropdownInput that says whether the saved link still stands. */
type SavedLink = Pick<DropdownInput, "currentEvent" | "savedDate" | "date">;

/**
 * What the dropdown holds right now.
 *
 * Someone's own choice comes first, while it is still on the shift's date. Then
 * the event the shift is already linked to, unless this popup moved it onto a day
 * that is not the event's: a shift moved off its event's date must not stay
 * pointing at it, and a shift not moved has its link left alone. Then the one
 * event that fits, if exactly one does and this popup may preselect. Two or more is
 * the manager's call, and so is none, so both start at None.
 */
export function selectedEventId(input: DropdownInput): number | null {
  if (input.pick === "none") return null;
  if (typeof input.pick === "number" && input.onDate.some((e) => e.id === input.pick)) return input.pick;
  if (input.currentDealId !== null && savedLinkStands(input)) return input.currentDealId;
  return input.preselect && input.fitting.length === 1 ? input.fitting[0].id : null;
}

/**
 * The event to name beside a dropdown on None, for a shift with no link opened
 * without a preselect: the one that fits, if exactly one does. Naming it writes
 * nothing. Choosing it takes a change of the dropdown.
 */
function suggestedEvent(input: DropdownInput): ScheduleEvent | null {
  if (input.preselect || input.currentDealId !== null || input.fitting.length !== 1) return null;
  return selectedEventId(input) === null ? input.fitting[0] : null;
}

/** Is the saved event still the shift's at this date: on that date, or the shift not moved? */
function savedLinkStands(input: SavedLink): boolean {
  return input.currentEvent !== null && (input.currentEvent.event_date === input.date || input.savedDate === input.date);
}

/** Will a save take the shift off its saved event because it moved to another day? */
export function movedOffSavedEvent(input: SavedLink): boolean {
  return input.currentEvent !== null && !savedLinkStands(input);
}

/**
 * The dropdown for a shift: what it lists, what it holds and what it suggests. The list is the
 * day's events for its position plus, while it stands, the event the shift is
 * saved on when that is not one on offer (a Catering shift's marketing event, or a
 * deal since closed some other way), so the link is shown, can be changed, and can be gone back to.
 *
 * Null for a linked shift whose deal was not read (gone, or with no date to sit
 * on). There is nothing to show, and a dropdown would read as None and clear it,
 * so the popup leaves the link alone.
 */
export function eventDropdown(input: DropdownInput): { selected: number | null; options: ScheduleEvent[]; suggested: ScheduleEvent | null } | null {
  const { currentDealId, currentEvent, onDate } = input;
  if (currentDealId !== null && currentEvent === null) return null;
  const notOnOffer = currentEvent !== null && savedLinkStands(input) && !onDate.some((e) => e.id === currentEvent.id);
  return { selected: selectedEventId(input), options: notOnOffer ? [...onDate, currentEvent] : onDate, suggested: suggestedEvent(input) };
}

/**
 * The event part of the popup's save body. deal_id goes in only when the dropdown
 * is settled (`selected` is undefined while there is none, or it is still loading)
 * and differs from what is stored, so a save that did not touch it cannot disturb
 * it, and an untouched preselect on an unlinked shift is saved.
 */
export function eventSaveFields(selected: number | null | undefined, storedDealId: number | null): { deal_id?: number | null } {
  return selected !== undefined && selected !== storedDealId ? { deal_id: selected } : {};
}

/** A shift as the badge reads it. A row can come back without deal_id. */
export type BadgeShift = Omit<CrewShift, "deal_id"> & { deal_id?: number | null };

export type EventBadge =
  | { kind: "suggest"; event: ScheduleEvent }
  | { kind: "choose"; events: ScheduleEvent[] };

/**
 * The badge on a shift: a Catering or Marketing shift with a person and no link
 * that fits at least one event of its kind. It judges the shift alone. Whether a
 * colleague on the same event is already linked changes nothing, so the rest of a
 * crew stays badged until each of them is done, including after the event finishes.
 * A finished event counts for FINISHED_BADGE_DAYS after its date, so old weeks do
 * not fill up with suggestions. `today` is New York's.
 */
export function eventBadge(shift: BadgeShift, events: ScheduleEvent[], today: string): EventBadge | null {
  if (!wantsEventBadge(shift)) return null;
  const oldest = addDays(today, -FINISHED_BADGE_DAYS);
  const current = events.filter((e) => e.stage !== FINISHED_STAGE || e.event_date >= oldest);
  const fits = fittingEvents(shift, eventsForPosition(shift.position, current));
  if (fits.length === 0) return null;
  return fits.length === 1 ? { kind: "suggest", event: fits[0] } : { kind: "choose", events: fits };
}

/**
 * A shift of either kind that is staffed and unlinked. For Catering that is
 * exactly isHandPlacedShift; Marketing is not added to that rule, because the
 * noon reminder and the shift reconciler also read it and a Marketing shift
 * covers nothing for them.
 */
function wantsEventBadge(shift: BadgeShift): boolean {
  return eventKindOf(shift.position) !== null && isUnlinkedStaffedShift({ ...shift, deal_id: shift.deal_id ?? null });
}

/** Every badged shift's badge, by shift id. Its size is the count on the button. */
export function eventBadges<T extends BadgeShift & { id: number }>(shifts: T[], events: ScheduleEvent[], today: string): Map<number, EventBadge> {
  const badges = new Map<number, EventBadge>();
  for (const shift of shifts) {
    const badge = eventBadge(shift, events, today);
    if (badge) badges.set(shift.id, badge);
  }
  return badges;
}

/** What the badge says. */
export function eventBadgeText(badge: EventBadge): string {
  return badge.kind === "suggest" ? `Event: ${badge.event.name}?` : "Choose an event";
}
