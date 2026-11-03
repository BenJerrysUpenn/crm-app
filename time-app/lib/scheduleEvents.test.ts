// The event selector and badge on the schedule: which events each position takes,
// what the popup preselects or suggests and which shifts get a badge. The saving side is
// lib/shiftEventLink.test.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "./testing/fakeSupabase.ts";
import type * as Events from "./scheduleEvents.ts";

const events = await loadAppModule<typeof Events>("lib/scheduleEvents.ts");
const { FINISHED_BADGE_DAYS, eventBadge, eventBadges, eventBadgeText, eventChipName, eventDropdown, eventFieldLabel, eventKindOf, eventOptionLabel, eventSaveFields, eventsForPosition, eventsOnDate, fittingEvents, isLinkableDeal, movedOffSavedEvent, selectedEventId, toScheduleEvent } = events;
const { isHandPlacedShift } = await loadAppModule<typeof import("./handPlacedCrew.ts")>("lib/handPlacedCrew.ts");
const { MARKETING_POSITION } = await loadAppModule<typeof import("./payroll/verify.ts")>("lib/payroll/verify.ts");

type Event = Events.ScheduleEvent;

function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}

const EVENT_A: Event = { id: 101, name: "Event A", stage: "Booked Paid", event_date: "2026-10-23", event_start_time: "12:00", event_end_time: "14:00" };
const EVENT_B: Event = { id: 102, name: "Event B", stage: "Booked Unpaid", event_date: "2026-10-23", event_start_time: "13:00", event_end_time: "15:00" };
const NEXT_DAY: Event = { id: 103, name: "Event C", stage: "Booked Paid", event_date: "2026-10-24", event_start_time: "12:00", event_end_time: "14:00" };
const MARKETING_A: Event = { id: 301, name: "Marketing A", stage: "Closed Marketing Event", event_date: "2026-10-23", event_start_time: "12:00", event_end_time: "14:00" };
const MARKETING_B: Event = { id: 302, name: "Marketing B", stage: "Closed Marketing Event", event_date: "2026-10-23", event_start_time: "13:00", event_end_time: "15:00" };
const FINISHED_CATERING: Event = { ...EVENT_A, id: 401, name: "Finished catering", stage: "Event Complete", finished_for: ["catering"] };
const FINISHED_MARKETING: Event = { ...EVENT_A, id: 402, name: "Finished marketing", stage: "Event Complete", finished_for: ["marketing"] };
const FINISHED_UNCLEAR: Event = { ...EVENT_A, id: 403, name: "Finished, kind unclear", stage: "Event Complete", finished_for: ["catering", "marketing"] };
/** New York's today in these tests: a week after the shifts' date. */
const TODAY = "2026-10-30";

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
    preselect: true,
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

test("a Catering shift can be linked at Booked Unpaid or Booked Paid; a marketing event, archived or any other stage cannot", () => {
  assert.equal(isLinkableDeal({ stage: "Booked Unpaid", archived: 0 }, "Catering"), true);
  assert.equal(isLinkableDeal({ stage: "Booked Paid", archived: 0 }, "Catering"), true);
  assert.equal(isLinkableDeal({ stage: "Closed Marketing Event", archived: 0 }, "Catering"), false);
  assert.equal(isLinkableDeal({ stage: "Booked Paid", archived: 1 }, "Catering"), false);
  assert.equal(isLinkableDeal({ stage: "Sent Quote", archived: 0 }, "Catering"), false);
});

test("a Marketing shift can be linked at Closed Marketing Event and no booked stage", () => {
  assert.equal(isLinkableDeal({ stage: "Closed Marketing Event", archived: 0 }, "Marketing"), true);
  assert.equal(isLinkableDeal({ stage: "Closed Marketing Event", archived: 1 }, "Marketing"), false);
  assert.equal(isLinkableDeal({ stage: "Booked Paid", archived: 0 }, "Marketing"), false);
  assert.equal(isLinkableDeal({ stage: "Booked Unpaid", archived: 0 }, "Marketing"), false);
});

test("any other position can be linked at nothing", () => {
  assert.equal(isLinkableDeal({ stage: "Booked Paid", archived: 0 }, "PENN Opener"), false);
  assert.equal(isLinkableDeal({ stage: "Closed Marketing Event", archived: 0 }, null), false);
});

test("the position says which events are listed, and what the field is called", () => {
  const all = [EVENT_A, EVENT_B, MARKETING_A, { ...EVENT_A, id: 400, stage: "Closed Lost" }];
  assert.deepEqual(eventsForPosition("Catering", all).map((e) => e.id), [101, 102]);
  assert.deepEqual(eventsForPosition(" Marketing ", all).map((e) => e.id), [301]);
  assert.deepEqual(eventsForPosition("PENN Opener", all), []);
  assert.deepEqual(eventsForPosition("", all), []);
  assert.equal(eventFieldLabel("Catering"), "Catering event");
  assert.equal(eventFieldLabel("Marketing"), "Marketing event");
  assert.equal(eventKindOf("PENN Opener"), null);
  assert.equal(eventKindOf("Marketing Lead"), null);
});

test("Marketing is the word payroll reads as a Marketing shift", () => {
  assert.equal(events.MARKETING_POSITION, MARKETING_POSITION);
});

test("an event's name is its own, then the company, then the venue", () => {
  const deal = { id: 1, event_date: "2026-10-23", event_start_time: "12:00", event_end_time: null, stage: "Booked Paid", archived: 0 };
  assert.equal(toScheduleEvent({ ...deal, event_name: "Name", company: "Company", venue_name: "Venue" })?.name, "Name");
  assert.equal(toScheduleEvent({ ...deal, event_name: "  ", company: "Company", venue_name: "Venue" })?.name, "Company");
  assert.equal(toScheduleEvent({ ...deal, company: null, venue_name: "Venue" })?.name, "Venue");
  assert.equal(toScheduleEvent(deal)?.name, "Catering event");
  assert.equal(toScheduleEvent({ ...deal, event_date: null }), null);
});

// --- the name on a linked shift's chip ------------------------------------------

test("the chip's name is the company", () => {
  assert.equal(eventChipName({ id: 1, company: "  Company  ", contact_first_name: "Pat", contact_last_name: "Test" }), "Company");
});

test("no company: the chip's name is the contact, with whichever parts there are", () => {
  assert.equal(eventChipName({ id: 1, company: "  ", contact_first_name: " Pat ", contact_last_name: "Test" }), "Pat Test");
  assert.equal(eventChipName({ id: 1, company: null, contact_first_name: "Pat", contact_last_name: null }), "Pat");
  assert.equal(eventChipName({ id: 1, company: null, contact_first_name: null, contact_last_name: "Test" }), "Test");
});

test("neither a company nor a contact: no name", () => {
  assert.equal(eventChipName({ id: 1, company: null, contact_first_name: "", contact_last_name: "  " }), null);
  assert.equal(eventChipName({ id: 1 }), null);
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
  assert.equal(selectedEventId({ preselect: true, pick: 101, currentDealId: null, currentEvent: null, date: "2026-10-23", onDate: [EVENT_A], fitting: [] }), 101);
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
  assert.equal(selectedEventId({ preselect: true, pick: "none", currentDealId: null, currentEvent: null, date: "2026-10-23", onDate: [EVENT_A], fitting: [EVENT_A] }), null);
});

test("a linked shift shows its own event, not the preselect", () => {
  assert.equal(
    selectedEventId({ preselect: false, pick: null, currentDealId: 102, currentEvent: EVENT_B, date: "2026-10-23", onDate: [EVENT_A, EVENT_B], fitting: [EVENT_A] }),
    102,
  );
});

test("a linked event that is no longer offered stays selected while it is on the shift's date", () => {
  const finished = { ...EVENT_A, id: 200 };
  assert.equal(selectedEventId({ preselect: false, pick: null, currentDealId: 200, currentEvent: finished, date: "2026-10-23", onDate: [], fitting: [] }), 200);
});

test("moved to another day: the old event is dropped and the new day's event that fits is not chosen for it", () => {
  assert.equal(selectedEventId({ preselect: false, pick: null, currentDealId: 101, currentEvent: EVENT_A, date: "2026-10-24", onDate: [], fitting: [] }), null);
  assert.equal(selectedEventId({ preselect: false, pick: null, currentDealId: 101, currentEvent: EVENT_A, date: "2026-10-24", onDate: [NEXT_DAY], fitting: [NEXT_DAY] }), null);
});

test("a choice made before the date changed does not follow the shift to another day", () => {
  assert.equal(selectedEventId({ preselect: true, pick: 101, currentDealId: null, currentEvent: null, date: "2026-10-24", onDate: [NEXT_DAY], fitting: [] }), null);
});

// --- opened without a preselect: a suggestion only --------------------------------

/** An unlinked shift's dropdown on 2026-10-23, opened from its chip, not its badge. */
function opened(onDate: Event[], over: Partial<Parameters<typeof eventDropdown>[0]> = {}) {
  return eventDropdown({ preselect: false, pick: null, currentDealId: null, currentEvent: null, date: "2026-10-23", onDate, fitting: fittingEvents(shift(), onDate), ...over });
}

test("opened without a preselect, one event fits: the dropdown stays on None and names it as a suggestion", () => {
  const shown = opened([EVENT_A]);
  assert.equal(shown?.selected, null);
  assert.equal(shown?.suggested?.id, 101);
  assert.deepEqual(shown?.options.map((e) => e.id), [101]);
});

test("the suggestion saves nothing: a save from that dropdown sends no deal_id", () => {
  assert.deepEqual(eventSaveFields(opened([EVENT_A])?.selected, null), {});
});

test("choosing the suggested event takes one change of the dropdown, and then it is no longer a suggestion", () => {
  const chosen = opened([EVENT_A], { pick: 101 });
  assert.equal(chosen?.selected, 101);
  assert.equal(chosen?.suggested, null);
  assert.deepEqual(eventSaveFields(chosen?.selected, null), { deal_id: 101 });
});

test("no suggestion when no event fits, or when two do", () => {
  const partial = shift({ starts_at: edt("2026-10-23", "12:30") });
  assert.equal(opened([EVENT_A], { fitting: fittingEvents(partial, [EVENT_A]) })?.suggested, null);
  assert.equal(opened([])?.suggested, null);
  const two = opened([EVENT_A, EVENT_B]);
  assert.equal(two?.selected, null);
  assert.equal(two?.suggested, null);
});

test("from a badge or for a new shift the one event that fits is preselected, with no suggestion beside it", () => {
  const shown = opened([EVENT_A], { preselect: true });
  assert.equal(shown?.selected, 101);
  assert.equal(shown?.suggested, null);
  assert.equal(opened([EVENT_A, EVENT_B], { preselect: true })?.selected, null);
});

test("a linked shift shows its link either way, and suggests nothing", () => {
  for (const preselect of [false, true]) {
    const shown = opened([EVENT_A, EVENT_B], { preselect, currentDealId: 102, currentEvent: EVENT_B, savedDate: "2026-10-23", fitting: [EVENT_A] });
    assert.equal(shown?.selected, 102);
    assert.equal(shown?.suggested, null);
  }
});

// --- a saved link the day does not offer -----------------------------------------

const SAVED_MARKETING: Event = { id: 300, name: "Marketing Event", stage: "Closed Marketing Event", event_date: "2026-10-23", event_start_time: "12:00", event_end_time: "14:00" };

function dropdown(over: Partial<Parameters<typeof eventDropdown>[0]> = {}) {
  return eventDropdown({ preselect: false, pick: null, currentDealId: 300, currentEvent: SAVED_MARKETING, date: "2026-10-23", onDate: [EVENT_A], fitting: [EVENT_A], ...over });
}

test("a Catering shift saved on a marketing event shows it, listed and selected, over a Booked event that fits", () => {
  const shown = dropdown();
  assert.equal(shown?.selected, 300);
  assert.deepEqual(shown?.options.map((e) => e.id), [101, 300]);
});

test("that link can be changed, cleared, and gone back to before saving", () => {
  assert.equal(dropdown({ pick: 101 })?.selected, 101);
  assert.deepEqual(dropdown({ pick: 101 })?.options.map((e) => e.id), [101, 300]);
  assert.equal(dropdown({ pick: "none" })?.selected, null);
  assert.deepEqual(dropdown({ pick: "none" })?.options.map((e) => e.id), [101, 300]);
  assert.equal(dropdown({ pick: 300 })?.selected, 300);
});

test("moved to another day: the saved event leaves the list, and the popup says so", () => {
  const moved = dropdown({ date: "2026-10-24", onDate: [NEXT_DAY], fitting: [] });
  assert.equal(moved?.selected, null);
  assert.deepEqual(moved?.options.map((e) => e.id), [103]);
});

test("a saved event the day already lists is not listed twice", () => {
  assert.deepEqual(dropdown({ currentDealId: 101, currentEvent: EVENT_A })?.options.map((e) => e.id), [101]);
});

test("a shift with no link lists only what the day offers", () => {
  const shown = dropdown({ currentDealId: null, currentEvent: null, preselect: true });
  assert.equal(shown?.selected, 101);
  assert.deepEqual(shown?.options.map((e) => e.id), [101]);
});

test("a linked shift whose deal was not read gets no dropdown, so a save cannot clear it", () => {
  assert.equal(dropdown({ currentEvent: null }), null);
});

test("a shift already off its event's date and not moved keeps showing the link, with nothing to warn about", () => {
  const offDay = { ...SAVED_MARKETING, event_date: "2026-10-22" };
  const unmoved = { currentEvent: offDay, savedDate: "2026-10-23", date: "2026-10-23" };
  const shown = dropdown({ ...unmoved, onDate: [] });
  assert.equal(shown?.selected, 300);
  assert.deepEqual(shown?.options.map((e) => e.id), [300]);
  assert.equal(movedOffSavedEvent(unmoved), false);
});

test("moved off its event's date in the popup: the link goes and the popup warns", () => {
  const moved = { currentEvent: SAVED_MARKETING, savedDate: "2026-10-23", date: "2026-10-24" };
  assert.equal(dropdown({ ...moved, onDate: [], fitting: [] })?.selected, null);
  assert.equal(movedOffSavedEvent(moved), true);
  assert.equal(movedOffSavedEvent({ ...moved, date: "2026-10-23" }), false);
});

test("a save sends the event only once the dropdown is settled and it differs from what is stored", () => {
  assert.deepEqual(eventSaveFields(undefined, 101), {});
  assert.deepEqual(eventSaveFields(undefined, null), {});
  assert.deepEqual(eventSaveFields(101, 101), {});
  assert.deepEqual(eventSaveFields(null, null), {});
});

test("a save sends a new event, an untouched preselect, and None over a stored link", () => {
  assert.deepEqual(eventSaveFields(102, 101), { deal_id: 102 });
  assert.deepEqual(eventSaveFields(101, null), { deal_id: 101 });
  assert.deepEqual(eventSaveFields(null, 101), { deal_id: null });
});

test("a past Marketing shift whose deal is now Event Complete shows that saved link", () => {
  const finished = { ...MARKETING_A, stage: "Event Complete" };
  const shown = eventDropdown({ preselect: false, pick: null, currentDealId: 301, currentEvent: finished, savedDate: "2026-10-23", date: "2026-10-23", onDate: [], fitting: [] });
  assert.equal(shown?.selected, 301);
  assert.deepEqual(shown?.options.map((e) => e.id), [301]);
});

// --- the badge ----------------------------------------------------------------

test("one event fits: the badge suggests it", () => {
  const badge = eventBadge(shift(), [EVENT_A], TODAY);
  assert.equal(badge?.kind, "suggest");
  assert.equal(eventBadgeText(badge!), "Event: Event A?");
});

test("two events fit: the badge says to choose", () => {
  const badge = eventBadge(shift(), [EVENT_A, EVENT_B], TODAY);
  assert.equal(badge?.kind, "choose");
  assert.equal(eventBadgeText(badge!), "Choose an event");
});

test("no event that day, like a concession shift: no badge", () => {
  assert.equal(eventBadge(shift(), [], TODAY), null);
  assert.equal(eventBadge(shift(), [NEXT_DAY], TODAY), null);
});

test("an event that day the shift does not cover: no badge", () => {
  assert.equal(eventBadge(shift({ ends_at: edt("2026-10-23", "13:00") }), [EVENT_A], TODAY), null);
});

test("only a published Catering shift with a person and no link gets a badge", () => {
  assert.equal(eventBadge(shift({ deal_id: 101 }), [EVENT_A], TODAY), null);
  assert.equal(eventBadge(shift({ employee_id: null }), [EVENT_A], TODAY), null);
  assert.equal(eventBadge(shift({ position: "PENN Opener" }), [EVENT_A], TODAY), null);
  assert.equal(eventBadge(shift({ published: false }), [EVENT_A], TODAY), null);
});

test("a Marketing shift's badge looks only at marketing events", () => {
  const marketing = shift({ position: "Marketing" });
  const one = eventBadge(marketing, [EVENT_A, MARKETING_A], TODAY);
  assert.equal(one?.kind === "suggest" && one.event.id, 301);
  assert.equal(eventBadge(marketing, [MARKETING_A, MARKETING_B], TODAY)?.kind, "choose");
  assert.equal(eventBadge(marketing, [EVENT_A], TODAY), null);
  assert.equal(eventBadge(shift({ position: " Marketing " }), [MARKETING_A], TODAY)?.kind, "suggest");
});

test("a Catering shift's badge looks only at booked events", () => {
  const one = eventBadge(shift(), [EVENT_A, MARKETING_A], TODAY);
  assert.equal(one?.kind === "suggest" && one.event.id, 101);
  assert.equal(eventBadge(shift(), [MARKETING_A], TODAY), null);
});

test("only a published Marketing shift with a person and no link gets a badge", () => {
  const marketing = { position: "Marketing" };
  assert.equal(eventBadge(shift({ ...marketing, deal_id: 301 }), [MARKETING_A], TODAY), null);
  assert.equal(eventBadge(shift({ ...marketing, employee_id: null }), [MARKETING_A], TODAY), null);
  assert.equal(eventBadge(shift({ ...marketing, published: false }), [MARKETING_A], TODAY), null);
});

test("the Marketing badge is its own path: a Marketing shift is still not hand-placed crew", () => {
  const marketing = shift({ position: "Marketing" });
  assert.notEqual(eventBadge(marketing, [MARKETING_A], TODAY), null);
  assert.equal(isHandPlacedShift(marketing), false);
});

test("a Marketing shift preselects the one marketing event it covers, and two start at None", () => {
  const marketing = shift({ position: "Marketing" });
  const pickFrom = (onDate: Event[]) =>
    selectedEventId({ preselect: true, pick: null, currentDealId: null, currentEvent: null, date: "2026-10-23", onDate, fitting: fittingEvents(marketing, onDate) });
  assert.equal(pickFrom(eventsForPosition("Marketing", [EVENT_A, MARKETING_A])), 301);
  assert.equal(pickFrom(eventsForPosition("Marketing", [MARKETING_A, MARKETING_B])), null);
  assert.equal(pickFrom(eventsForPosition("Marketing", [EVENT_A])), null);
});

test("a row with no deal_id field reads as unlinked", () => {
  const { deal_id: _unused, ...row } = shift();
  assert.equal(eventBadge(row, [EVENT_A], TODAY)?.kind, "suggest");
});

test("the count is the number of badged shifts", () => {
  const shifts = [
    shift({ id: 1 }),
    shift({ id: 2, employee_id: "person-2" }),
    shift({ id: 3, deal_id: 102 }),
    shift({ id: 4, starts_at: edt("2026-10-25", "11:00"), ends_at: edt("2026-10-25", "16:00") }),
  ];
  assert.deepEqual([...eventBadges(shifts, [EVENT_A], TODAY).keys()], [1, 2]);
});

test("one of three linked: the other two keep their badges until each is done", () => {
  const crew = [
    shift({ id: 1, employee_id: "person-1", deal_id: 101 }),
    shift({ id: 2, employee_id: "person-2" }),
    shift({ id: 3, employee_id: "person-3" }),
  ];
  assert.deepEqual([...eventBadges(crew, [EVENT_A], TODAY).keys()], [2, 3]);
  crew[1].deal_id = 101 as never;
  assert.deepEqual([...eventBadges(crew, [EVENT_A], TODAY).keys()], [3]);
});

test("a shift saved as None with an event that fits keeps its badge: nothing records the choice", () => {
  assert.equal(eventBadge(shift({ deal_id: null }), [EVENT_A], TODAY)?.kind, "suggest");
});

// --- finished events ------------------------------------------------------------

test("a finished event is linkable by the kinds it is for, live only, and Closed Lost and the rest stay out", () => {
  const finished = (finished_for?: Events.EventKind[], archived = 0) => ({ stage: "Event Complete", archived, finished_for });
  assert.equal(isLinkableDeal(finished(["catering"]), "Catering"), true);
  assert.equal(isLinkableDeal(finished(["catering"]), "Marketing"), false);
  assert.equal(isLinkableDeal(finished(["marketing"]), "Marketing"), true);
  assert.equal(isLinkableDeal(finished(["marketing"]), "Catering"), false);
  assert.equal(isLinkableDeal(finished(["catering", "marketing"]), "Catering"), true);
  assert.equal(isLinkableDeal(finished(["catering", "marketing"]), "Marketing"), true);
  assert.equal(isLinkableDeal(finished(["catering"], 1), "Catering"), false);
  assert.equal(isLinkableDeal(finished(["catering", "marketing"]), "PENN Opener"), false);
  for (const stage of ["Closed Lost", "Closed Below Min", "Open", "Sent Quote", "Quote Review"]) {
    assert.equal(isLinkableDeal({ stage, archived: 0, finished_for: ["catering", "marketing"] }, "Catering"), false, stage);
    assert.equal(isLinkableDeal({ stage, archived: 0, finished_for: ["catering", "marketing"] }, "Marketing"), false, stage);
  }
});

test("each position lists its own finished events, and one that can't be told shows for both", () => {
  const all = [FINISHED_CATERING, FINISHED_MARKETING, FINISHED_UNCLEAR];
  assert.deepEqual(eventsForPosition("Catering", all).map((e) => e.id), [401, 403]);
  assert.deepEqual(eventsForPosition("Marketing", all).map((e) => e.id), [402, 403]);
  assert.deepEqual(eventsForPosition("PENN Opener", all), []);
});

test("a finished event that came with no answer on its kind shows for both", () => {
  const { finished_for: _ignored, ...bare } = FINISHED_CATERING;
  assert.deepEqual(eventsForPosition("Catering", [bare]).map((e) => e.id), [401]);
  assert.deepEqual(eventsForPosition("Marketing", [bare]).map((e) => e.id), [401]);
});

test("the one finished event a shift covers is listed and preselected", () => {
  const onDate = eventsForPosition("Catering", [FINISHED_CATERING, FINISHED_MARKETING]);
  assert.deepEqual(onDate.map((e) => e.id), [401]);
  assert.equal(preselect(onDate), 401);
});

test("a finished event beside another that also fits: nothing is preselected", () => {
  assert.equal(preselect(eventsForPosition("Catering", [EVENT_A, FINISHED_CATERING])), null);
});

test("a finished event the shift doesn't cover is listed and not preselected", () => {
  const short = shift({ starts_at: edt("2026-10-23", "13:00") });
  assert.equal(preselect([FINISHED_CATERING], short), null);
});

test("a shift linked to a finished event keeps showing it, once, over one the shift also covers", () => {
  const shown = eventDropdown({ preselect: false, pick: null, currentDealId: 401, currentEvent: FINISHED_CATERING, savedDate: "2026-10-23", date: "2026-10-23", onDate: [EVENT_A, FINISHED_CATERING], fitting: [EVENT_A, FINISHED_CATERING] });
  assert.equal(shown?.selected, 401);
  assert.deepEqual(shown?.options.map((e) => e.id), [101, 401]);
});

test("None beats a finished event's preselect, and a date move takes the shift off one", () => {
  const onDate = [FINISHED_CATERING];
  assert.equal(selectedEventId({ preselect: true, pick: "none", currentDealId: null, currentEvent: null, date: "2026-10-23", onDate, fitting: onDate }), null);
  const moved = { currentEvent: FINISHED_CATERING, savedDate: "2026-10-23", date: "2026-10-24" };
  assert.equal(movedOffSavedEvent(moved), true);
  assert.equal(eventDropdown({ preselect: false, pick: null, currentDealId: 401, ...moved, onDate: [], fitting: [] })?.selected, null);
});

test("the badge counts a finished event of its own kind, and one that can't be told for both", () => {
  const marketing = shift({ position: "Marketing" });
  assert.equal(eventBadge(shift(), [FINISHED_MARKETING], TODAY), null);
  assert.equal(eventBadge(marketing, [FINISHED_CATERING], TODAY), null);
  const own = eventBadge(shift(), [FINISHED_CATERING, FINISHED_MARKETING], TODAY);
  assert.equal(own?.kind === "suggest" && own.event.id, 401);
  assert.equal(eventBadge(shift(), [FINISHED_UNCLEAR], TODAY)?.kind, "suggest");
  assert.equal(eventBadge(marketing, [FINISHED_UNCLEAR], TODAY)?.kind, "suggest");
});

test("a finished event badges for 14 days after its date and not on the 15th", () => {
  assert.equal(FINISHED_BADGE_DAYS, 14);
  assert.equal(eventBadge(shift(), [FINISHED_CATERING], "2026-10-23")?.kind, "suggest");
  assert.equal(eventBadge(shift(), [FINISHED_CATERING], "2026-11-06")?.kind, "suggest");
  assert.equal(eventBadge(shift(), [FINISHED_CATERING], "2026-11-07"), null);
});

test("14 days is read across the clocks going back", () => {
  // 2026-11-01 is the change; the shift is on the Saturday before it.
  const event = { ...FINISHED_CATERING, event_date: "2026-10-31" };
  const saturday = shift({ starts_at: edt("2026-10-31", "11:00"), ends_at: edt("2026-10-31", "16:00") });
  assert.equal(eventBadge(saturday, [event], "2026-11-14")?.kind, "suggest");
  assert.equal(eventBadge(saturday, [event], "2026-11-15"), null);
});

test("the 14 days limit a finished event only: a booked one in the past badges as it did", () => {
  assert.equal(eventBadge(shift(), [EVENT_A], "2027-06-01")?.kind, "suggest");
  assert.equal(eventBadge(shift({ position: "Marketing" }), [MARKETING_A], "2027-06-01")?.kind, "suggest");
});

test("an old finished event beside a booked one that also fits: the badge suggests the booked one", () => {
  const badge = eventBadge(shift(), [FINISHED_CATERING, EVENT_A], "2026-12-01");
  assert.equal(badge?.kind === "suggest" && badge.event.id, 101);
});

test("the person left behind keeps their badge when the event finishes", () => {
  const crew = [
    shift({ id: 1, deal_id: 101 }),
    shift({ id: 2, employee_id: "person-2" }),
  ];
  assert.deepEqual([...eventBadges(crew, [EVENT_A], TODAY).keys()], [2]);
  const finished = { ...EVENT_A, stage: "Event Complete", finished_for: ["catering"] as Events.EventKind[] };
  assert.deepEqual([...eventBadges(crew, [finished], TODAY).keys()], [2]);
});
