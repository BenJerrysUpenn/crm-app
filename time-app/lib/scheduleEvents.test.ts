// The Catering event selector and badge on the schedule: what the popup
// preselects and which shifts get a badge. The saving side is
// lib/shiftEventLink.test.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "./testing/fakeSupabase.ts";
import type * as Events from "./scheduleEvents.ts";

const events = await loadAppModule<typeof Events>("lib/scheduleEvents.ts");
const { eventBadge, eventBadges, eventBadgeText, eventOptionLabel, eventsOnDate, fittingEvents, isLinkableDeal, selectedEventId, toScheduleEvent } = events;

type Event = Events.ScheduleEvent;

function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}

const EVENT_A: Event = { id: 101, name: "Event A", event_date: "2026-10-23", event_start_time: "12:00", event_end_time: "14:00" };
const EVENT_B: Event = { id: 102, name: "Event B", event_date: "2026-10-23", event_start_time: "13:00", event_end_time: "15:00" };
const NEXT_DAY: Event = { id: 103, name: "Event C", event_date: "2026-10-24", event_start_time: "12:00", event_end_time: "14:00" };

function shift(over: Partial<Events.BadgeShift & { id: number }> = {}) {
  return {
    id: 1,
    employee_id: "person-1",
    starts_at: edt("2026-10-23", "11:00"),
    ends_at: edt("2026-10-23", "16:00"),
    position: "Catering",
    published: true,
    deal_id: null,
    ...over,
  };
}

function preselect(onDate: Event[], s = shift()) {
  return selectedEventId({
    pick: null,
    currentDealId: null,
    currentEvent: null,
    date: "2026-10-23",
    onDate,
    fitting: fittingEvents(s, onDate),
  });
}

// --- the dropdown's list ------------------------------------------------------

test("the dropdown lists a day's events earliest first, with no time set last", () => {
  const noTime: Event = { ...EVENT_A, id: 104, event_start_time: null, event_end_time: null };
  assert.deepEqual(eventsOnDate([noTime, EVENT_B, NEXT_DAY, EVENT_A], "2026-10-23").map((e) => e.id), [101, 102, 104]);
});

test("an event's label is its name and time", () => {
  assert.equal(eventOptionLabel(EVENT_A), "Event A · 12:00 PM–2:00 PM");
  assert.equal(eventOptionLabel({ ...EVENT_A, event_end_time: null }), "Event A · 12:00 PM");
  assert.equal(eventOptionLabel({ ...EVENT_A, event_start_time: null }), "Event A · time not set");
});

test("Booked Unpaid, Booked Paid and Closed Marketing Event can be linked, archived or any other stage cannot", () => {
  assert.equal(isLinkableDeal({ stage: "Booked Unpaid", archived: 0 }), true);
  assert.equal(isLinkableDeal({ stage: "Booked Paid", archived: 0 }), true);
  assert.equal(isLinkableDeal({ stage: "Closed Marketing Event", archived: 0 }), true);
  assert.equal(isLinkableDeal({ stage: "Booked Paid", archived: 1 }), false);
  assert.equal(isLinkableDeal({ stage: "Event Complete", archived: 0 }), false);
  assert.equal(isLinkableDeal({ stage: "Sent Quote", archived: 0 }), false);
});

test("an event's name is its own, then the company, then the venue", () => {
  const deal = { id: 1, event_date: "2026-10-23", event_start_time: "12:00", event_end_time: null, stage: "Booked Paid", archived: 0 };
  assert.equal(toScheduleEvent({ ...deal, event_name: "Name", company: "Company", venue_name: "Venue" })?.name, "Name");
  assert.equal(toScheduleEvent({ ...deal, event_name: "  ", company: "Company", venue_name: "Venue" })?.name, "Company");
  assert.equal(toScheduleEvent({ ...deal, company: null, venue_name: "Venue" })?.name, "Venue");
  assert.equal(toScheduleEvent(deal)?.name, "Catering event");
  assert.equal(toScheduleEvent({ ...deal, event_date: null }), null);
});

// --- preselect ----------------------------------------------------------------

test("exactly one event fits: it is preselected", () => {
  assert.equal(preselect([EVENT_A]), 101);
});

test("one fits and another that day does not: the one that fits is preselected", () => {
  const short = shift({ starts_at: edt("2026-10-23", "11:00"), ends_at: edt("2026-10-23", "14:30") });
  assert.deepEqual(fittingEvents(short, [EVENT_A, EVENT_B]).map((e) => e.id), [101]);
  assert.equal(preselect([EVENT_A, EVENT_B], short), 101);
});

test("two events fit: nothing is preselected", () => {
  assert.equal(fittingEvents(shift(), [EVENT_A, EVENT_B]).length, 2);
  assert.equal(preselect([EVENT_A, EVENT_B]), null);
});

test("no event fits: nothing is preselected, and the day's events can still be picked by hand", () => {
  const partial = shift({ starts_at: edt("2026-10-23", "12:30"), ends_at: edt("2026-10-23", "16:00") });
  assert.deepEqual(fittingEvents(partial, [EVENT_A]), []);
  assert.equal(preselect([EVENT_A], partial), null);
  assert.equal(selectedEventId({ pick: 101, currentDealId: null, currentEvent: null, date: "2026-10-23", onDate: [EVENT_A], fitting: [] }), 101);
});

test("no event that day: nothing is preselected", () => {
  assert.equal(preselect([]), null);
});

test("an event with no start time cannot be judged, so it never fits", () => {
  assert.deepEqual(fittingEvents(shift(), [{ ...EVENT_A, event_start_time: null }]), []);
});

test("an event on another day does not fit, even inside a long shift", () => {
  const overnight = shift({ starts_at: edt("2026-10-23", "11:00"), ends_at: edt("2026-10-24", "15:00") });
  assert.deepEqual(fittingEvents(overnight, [NEXT_DAY]), []);
});

test("an unfinished time fits nothing and does not throw", () => {
  assert.deepEqual(fittingEvents(shift({ starts_at: "not a time" }), [EVENT_A]), []);
});

test("choosing None beats the preselect", () => {
  assert.equal(selectedEventId({ pick: "none", currentDealId: null, currentEvent: null, date: "2026-10-23", onDate: [EVENT_A], fitting: [EVENT_A] }), null);
});

test("a linked shift shows its own event, not the preselect", () => {
  assert.equal(
    selectedEventId({ pick: null, currentDealId: 102, currentEvent: EVENT_B, date: "2026-10-23", onDate: [EVENT_A, EVENT_B], fitting: [EVENT_A] }),
    102,
  );
});

test("a linked event that is no longer offered stays selected while it is on the shift's date", () => {
  const finished = { ...EVENT_A, id: 200 };
  assert.equal(selectedEventId({ pick: null, currentDealId: 200, currentEvent: finished, date: "2026-10-23", onDate: [], fitting: [] }), 200);
});

test("moved to another day: the old event is dropped and the new day is judged afresh", () => {
  assert.equal(selectedEventId({ pick: null, currentDealId: 101, currentEvent: EVENT_A, date: "2026-10-24", onDate: [], fitting: [] }), null);
  assert.equal(selectedEventId({ pick: null, currentDealId: 101, currentEvent: EVENT_A, date: "2026-10-24", onDate: [NEXT_DAY], fitting: [NEXT_DAY] }), 103);
});

test("a choice made before the date changed does not follow the shift to another day", () => {
  assert.equal(selectedEventId({ pick: 101, currentDealId: null, currentEvent: null, date: "2026-10-24", onDate: [NEXT_DAY], fitting: [] }), null);
});

// --- the badge ----------------------------------------------------------------

test("one event fits: the badge suggests it", () => {
  const badge = eventBadge(shift(), [EVENT_A]);
  assert.equal(badge?.kind, "suggest");
  assert.equal(eventBadgeText(badge!), "Event: Event A?");
});

test("two events fit: the badge says to choose", () => {
  const badge = eventBadge(shift(), [EVENT_A, EVENT_B]);
  assert.equal(badge?.kind, "choose");
  assert.equal(eventBadgeText(badge!), "Choose an event");
});

test("no event that day, like a concession shift: no badge", () => {
  assert.equal(eventBadge(shift(), []), null);
  assert.equal(eventBadge(shift(), [NEXT_DAY]), null);
});

test("an event that day the shift does not cover: no badge", () => {
  assert.equal(eventBadge(shift({ ends_at: edt("2026-10-23", "13:00") }), [EVENT_A]), null);
});

test("only a published Catering shift with a person and no link gets a badge", () => {
  assert.equal(eventBadge(shift({ deal_id: 101 }), [EVENT_A]), null);
  assert.equal(eventBadge(shift({ employee_id: null }), [EVENT_A]), null);
  assert.equal(eventBadge(shift({ position: "PENN Opener" }), [EVENT_A]), null);
  assert.equal(eventBadge(shift({ published: false }), [EVENT_A]), null);
});

test("a row with no deal_id field reads as unlinked", () => {
  const { deal_id: _unused, ...row } = shift();
  assert.equal(eventBadge(row, [EVENT_A])?.kind, "suggest");
});

test("the count is the number of badged shifts", () => {
  const shifts = [
    shift({ id: 1 }),
    shift({ id: 2, employee_id: "person-2" }),
    shift({ id: 3, deal_id: 102 }),
    shift({ id: 4, starts_at: edt("2026-10-25", "11:00"), ends_at: edt("2026-10-25", "16:00") }),
  ];
  assert.deepEqual([...eventBadges(shifts, [EVENT_A]).keys()], [1, 2]);
});

test("one of three linked: the other two keep their badges until each is done", () => {
  const crew = [
    shift({ id: 1, employee_id: "person-1", deal_id: 101 }),
    shift({ id: 2, employee_id: "person-2" }),
    shift({ id: 3, employee_id: "person-3" }),
  ];
  assert.deepEqual([...eventBadges(crew, [EVENT_A]).keys()], [2, 3]);
  crew[1].deal_id = 101 as never;
  assert.deepEqual([...eventBadges(crew, [EVENT_A]).keys()], [3]);
});

test("a shift saved as None with an event that fits keeps its badge: nothing records the choice", () => {
  assert.equal(eventBadge(shift({ deal_id: null }), [EVENT_A])?.kind, "suggest");
});
