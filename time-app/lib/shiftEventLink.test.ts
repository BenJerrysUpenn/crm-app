// Saving a shift's event through the shift routes: who may, which slot
// it takes, what clears it. The rule for what the popup shows is
// lib/scheduleEvents.test.ts; the database's own guards are
// supabase/migration_30_verify.sql and migration_34_verify.sql.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;
type Collection = { POST: (request: Request) => Promise<Response> };

const shiftById = await loadAppModule<{ PATCH: Handler }>("app/api/shifts/[id]/route.ts");
const shifts = await loadAppModule<Collection>("app/api/shifts/route.ts");
const eventsRoute = await loadAppModule<{ GET: (request: Request) => Promise<Response> }>("app/api/schedule/events/route.ts");
const { finishedEventKinds, loadEventNames, loadLinkedEvents, loadScheduleEvents, planEventLink } = await loadAppModule<typeof import("./shiftEventLink.ts")>("lib/shiftEventLink.ts");
const { eventBadges, eventDropdown, eventsForPosition, fittingEvents } = await loadAppModule<typeof import("./scheduleEvents.ts")>("lib/scheduleEvents.ts");
const { createClient } = await loadAppModule<typeof import("./supabase/server.ts")>("lib/supabase/server.ts");

const OWNER = "00000000-0000-0000-0000-00000000000c";
const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";

function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}
function req(method: string, body: unknown): Request {
  return new Request("http://time.test/api", { method, body: JSON.stringify(body) });
}
const id = (n: number) => ({ params: { id: String(n) } });

const DEAL = { id: 500, event_name: "Event A", company: null, venue_name: null, event_date: "2026-10-23", event_start_time: "12:00", event_end_time: "14:00", stage: "Booked Paid", archived: 0 };
const OTHER_DAY = { ...DEAL, id: 501, event_date: "2026-10-24" };
const MARKETING = { ...DEAL, id: 502, stage: "Closed Marketing Event" };
// Finished events sit on their own day, so the booked day's tests keep their one fit.
const FINISHED_DAY = "2026-10-28";
const FINISHED = { ...DEAL, id: 503, stage: "Event Complete", event_date: FINISHED_DAY };
const FINISHED_MARKETING = { ...FINISHED, id: 510, event_type: "Marketing Event" };
const FINISHED_ARCHIVED = { ...FINISHED, id: 511, archived: 1 };
const CLOSED_LOST = { ...DEAL, id: 507, stage: "Closed Lost", event_date: FINISHED_DAY };
const ARCHIVED = { ...DEAL, id: 504, archived: 1 };
const SAME_DAY = { ...DEAL, id: 505, event_name: "Event B", stage: "Booked Unpaid" };
const MARKETING_ONLY_DAY = { ...MARKETING, id: 506, event_date: "2026-10-26" };
// A deal with everything a name must not bring along.
const NAMED = {
  ...DEAL,
  id: 600,
  event_date: "2026-10-30",
  company: "Test Company",
  contact_first_name: "Pat",
  contact_last_name: "Test",
  contact_email: "pat@example.test",
  contact_phone: "555-0100",
  total_price: 1234.5,
};
const CONTACT_ONLY = { ...NAMED, id: 601, company: "  " };
const NAMELESS = { ...NAMED, id: 602, company: null, contact_first_name: null, contact_last_name: null };

// Shift 1: on a person, placed on the page, no event yet.
const PLACED = { id: 1, employee_id: SAM, location_id: 1, starts_at: edt("2026-10-23", "11:00"), ends_at: edt("2026-10-23", "15:00"), position: "Catering", notes: null, published: true, deal_id: null, deal_slot: null };

/** New York's today in these tests: a few days after every event above. */
const TODAY = "2026-11-02";

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: OWNER, role: "owner", active: true, full_name: "Test Owner", phone: null },
      { id: MANAGER, role: "manager", active: true, full_name: "Test Manager", phone: null },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee", phone: null },
    ],
    shifts: [{ ...PLACED }],
    deals: [{ ...DEAL }, { ...OTHER_DAY }, { ...MARKETING }, { ...FINISHED }, { ...ARCHIVED }, { ...SAME_DAY }, { ...MARKETING_ONLY_DAY }, { ...FINISHED_MARKETING }, { ...FINISHED_ARCHIVED }, { ...CLOSED_LOST }, { ...NAMED }, { ...CONTACT_ONLY }, { ...NAMELESS }],
    shift_requests: [],
    shift_notices: [],
    availability: [],
    notifications: [],
  });
  db.signIn(MANAGER);
});

const ON_FINISHED_DAY = { starts_at: edt(FINISHED_DAY, "11:00"), ends_at: edt(FINISHED_DAY, "15:00") };

const shift = (n: number) => db.rows("shifts").find((s) => s.id === n)!;
const patch = (n: number, body: unknown) => shiftById.PATCH(req("PATCH", { confirmAvailability: true, ...(body as object) }), id(n));

function addLinked(over: Record<string, unknown>) {
  db.rows("shifts").push({ ...PLACED, id: 50 + db.rows("shifts").length, employee_id: null, deal_id: 500, deal_slot: 1, ...over });
}

function newShiftBody(over: Record<string, unknown> = {}) {
  return { employee_id: SAM, starts_at: PLACED.starts_at, ends_at: PLACED.ends_at, position: "Catering", confirmAvailability: true, ...over };
}

// --- saving -------------------------------------------------------------------

test("saving an event writes deal_id and the first slot", async () => {
  const res = await patch(1, { deal_id: 500 });
  assert.equal(res.status, 200);
  assert.equal(shift(1).deal_id, 500);
  assert.equal(shift(1).deal_slot, 1);
});

test("an open system-made shift's slot is left alone and the next free one is taken", async () => {
  addLinked({ deal_slot: 1 });
  addLinked({ deal_slot: 4, position: "Marketing" });
  const res = await patch(1, { deal_id: 500 });
  assert.equal(res.status, 200);
  assert.equal(shift(1).deal_slot, 5);
  assert.equal(db.rows("shifts").filter((s) => s.deal_id === 500 && s.employee_id === null).length, 2);
});

test("someone else taking the slot first: the save reads again and takes the next one", async () => {
  let raced = false;
  db.beforeWrite = (table) => {
    if (table !== "shifts" || raced) return;
    raced = true;
    addLinked({ deal_slot: 1 });
  };
  const res = await patch(1, { deal_id: 500 });
  assert.equal(res.status, 200);
  assert.equal(shift(1).deal_slot, 2);
});

test("a new shift can be saved with its event, and each of several gets its own slot", async () => {
  const a = await shifts.POST(req("POST", newShiftBody({ deal_id: 500 })));
  const b = await shifts.POST(req("POST", newShiftBody({ employee_id: null, deal_id: 500 })));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await a.json()).shift.deal_slot, 1);
  assert.equal((await b.json()).shift.deal_slot, 2);
});

test("a new shift with no event writes neither column", async () => {
  const res = await shifts.POST(req("POST", newShiftBody({ deal_id: null })));
  assert.equal(res.status, 200);
  const { shift: row } = await res.json();
  assert.equal(row.deal_id ?? null, null);
  assert.equal(row.deal_slot ?? null, null);
});

test("a Closed Marketing Event cannot be linked, and nothing changes", async () => {
  assert.equal((await patch(1, { deal_id: 502 })).status, 400);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).deal_slot, null);
  assert.equal((await shifts.POST(req("POST", newShiftBody({ deal_id: 502 })))).status, 400);
  assert.equal(db.rows("shifts").length, 1);
});

test("switching events takes a slot on the new one", async () => {
  await patch(1, { deal_id: 500 });
  addLinked({ deal_id: 505, deal_slot: 1 });
  assert.equal((await patch(1, { deal_id: 505 })).status, 200);
  assert.equal(shift(1).deal_id, 505);
  assert.equal(shift(1).deal_slot, 2);
});

test("saving the event it already has keeps its slot", async () => {
  db.rows("shifts")[0].deal_id = 500;
  db.rows("shifts")[0].deal_slot = 7;
  assert.equal((await patch(1, { deal_id: 500 })).status, 200);
  assert.equal(shift(1).deal_slot, 7);
});

// --- None ---------------------------------------------------------------------

test("None clears both columns", async () => {
  db.rows("shifts")[0].deal_id = 500;
  db.rows("shifts")[0].deal_slot = 3;
  assert.equal((await patch(1, { deal_id: null })).status, 200);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).deal_slot, null);
});

test("None on a shift with no event writes nothing to either column", async () => {
  assert.equal((await patch(1, { deal_id: null })).status, 200);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).deal_slot, null);
});

// --- changing the date --------------------------------------------------------

test("moving a linked shift to another day clears its event", async () => {
  db.rows("shifts")[0].deal_id = 500;
  db.rows("shifts")[0].deal_slot = 3;
  const res = await patch(1, { starts_at: edt("2026-10-25", "11:00"), ends_at: edt("2026-10-25", "15:00") });
  assert.equal(res.status, 200);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).deal_slot, null);
});

test("moving the time on the same day keeps the event", async () => {
  db.rows("shifts")[0].deal_id = 500;
  db.rows("shifts")[0].deal_slot = 3;
  await patch(1, { starts_at: edt("2026-10-23", "10:00") });
  assert.equal(shift(1).deal_id, 500);
  assert.equal(shift(1).deal_slot, 3);
});

test("moving to another day and choosing that day's event in one save links the new event", async () => {
  db.rows("shifts")[0].deal_id = 500;
  db.rows("shifts")[0].deal_slot = 3;
  const res = await patch(1, { starts_at: edt("2026-10-24", "11:00"), ends_at: edt("2026-10-24", "15:00"), deal_id: 501 });
  assert.equal(res.status, 200);
  assert.equal(shift(1).deal_id, 501);
  assert.equal(shift(1).deal_slot, 1);
});

test("an event on another day is refused and nothing changes", async () => {
  const res = await patch(1, { deal_id: 501 });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "That event is on a different day from this shift.");
  assert.equal(shift(1).deal_id, null);
});

test("a date boundary is New York's: 11pm on the 23rd is the 23rd", async () => {
  const late = await shifts.POST(req("POST", newShiftBody({ starts_at: edt("2026-10-23", "23:00"), ends_at: new Date(`2026-10-24T01:00:00-04:00`).toISOString(), deal_id: 500 })));
  assert.equal(late.status, 200);
});

test("a linked shift off its event's day, moved onto that day, keeps its event and slot", async () => {
  db.rows("shifts")[0].starts_at = edt("2026-10-22", "11:00");
  db.rows("shifts")[0].ends_at = edt("2026-10-22", "15:00");
  db.rows("shifts")[0].deal_id = 500;
  db.rows("shifts")[0].deal_slot = 3;
  const res = await patch(1, { starts_at: edt("2026-10-23", "11:00"), ends_at: edt("2026-10-23", "15:00") });
  assert.equal(res.status, 200);
  assert.equal(shift(1).deal_id, 500);
  assert.equal(shift(1).deal_slot, 3);
});

// --- refusals -----------------------------------------------------------------

test("staff are refused on both routes and nothing is written", async () => {
  db.signIn(SAM);
  assert.equal((await patch(1, { deal_id: 500 })).status, 403);
  assert.equal((await shifts.POST(req("POST", newShiftBody({ deal_id: 500 })))).status, 403);
  assert.equal(shift(1).deal_id, null);
  assert.equal(db.rows("shifts").length, 1);
});

test("staff cannot read the day's events", async () => {
  db.signIn(SAM);
  const res = await eventsRoute.GET(new Request("http://time.test/api?date=2026-10-23"));
  assert.equal(res.status, 403);
});

test("an owner passes the same gate", async () => {
  db.signIn(OWNER);
  assert.equal((await patch(1, { deal_id: 500 })).status, 200);
  assert.equal(shift(1).deal_id, 500);
});

test("a shift that isn't Catering or Marketing cannot take an event", async () => {
  const res = await patch(1, { position: "PENN Opener", deal_id: 500 });
  assert.equal(res.status, 400);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).position, "Catering");
});

test("an archived or missing event is refused", async () => {
  assert.equal((await patch(1, { deal_id: 504 })).status, 400);
  assert.equal((await patch(1, { deal_id: 999 })).status, 400);
  assert.equal(shift(1).deal_id, null);
});

test("a deal_id that is not an id is refused", async () => {
  assert.equal((await patch(1, { deal_id: "500" })).status, 400);
  assert.equal((await shifts.POST(req("POST", newShiftBody({ deal_id: -1 })))).status, 400);
  assert.equal(shift(1).deal_id, null);
});

// --- when the database can't answer --------------------------------------------

test("the event can't be read: the save answers 503 and the shift is not linked", async () => {
  db.missingTables = ["deals"];
  const res = await patch(1, { deal_id: 500 });
  assert.equal(res.status, 503);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).deal_slot, null);
});

test("the event can't be read when a linked shift moves day: the move answers 503 and nothing changes", async () => {
  db.rows("shifts")[0].deal_id = 500;
  db.rows("shifts")[0].deal_slot = 3;
  db.missingTables = ["deals"];
  const res = await patch(1, { starts_at: edt("2026-10-25", "11:00"), ends_at: edt("2026-10-25", "15:00") });
  assert.equal(res.status, 503);
  assert.equal(shift(1).starts_at, PLACED.starts_at);
  assert.equal(shift(1).deal_id, 500);
  assert.equal(shift(1).deal_slot, 3);
});

test("a slot taken on every try: the save gives up with an error and the shift is not linked", async () => {
  db.beforeWrite = (table) => {
    if (table !== "shifts") return;
    const taken = db.rows("shifts").filter((s) => s.deal_id === 500).map((s) => s.deal_slot as number);
    addLinked({ deal_slot: Math.max(0, ...taken) + 1 });
  };
  const res = await patch(1, { deal_id: 500 });
  assert.equal(res.status, 400);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).deal_slot, null);
});

test("the events route answers 503 when the events can't be read", async () => {
  db.missingTables = ["deals"];
  const res = await eventsRoute.GET(new Request("http://time.test/api?date=2026-10-23"));
  assert.equal(res.status, 503);
});

// --- leaving everything else alone --------------------------------------------

test("an edit with no deal_id leaves the link alone", async () => {
  db.rows("shifts")[0].deal_id = 500;
  db.rows("shifts")[0].deal_slot = 3;
  await patch(1, { notes: "bring the cart" });
  assert.equal(shift(1).deal_id, 500);
  assert.equal(shift(1).deal_slot, 3);
});

test("a linked shift already off its event's day, edited without moving, keeps its event and slot", async () => {
  Object.assign(db.rows("shifts")[0], { starts_at: edt("2026-10-22", "11:00"), ends_at: edt("2026-10-22", "15:00"), deal_id: 500, deal_slot: 3 });
  assert.equal((await patch(1, { notes: "bring the cart" })).status, 200);
  assert.equal(shift(1).deal_id, 500);
  assert.equal(shift(1).deal_slot, 3);
});

test("a save that only changes the event tells nobody", async () => {
  const res = await patch(1, { employee_id: SAM, location_id: 1, starts_at: PLACED.starts_at, ends_at: PLACED.ends_at, position: "Catering", notes: null, deal_id: 500 });
  assert.equal(res.status, 200);
  assert.equal(shift(1).deal_id, 500);
  assert.deepEqual(db.rows("shift_notices"), []);
  assert.deepEqual(db.rows("notifications"), []);
});

test("changing the event along with something else still tells the person", async () => {
  await patch(1, { notes: "bring the cart", deal_id: 500 });
  assert.equal(db.rows("shift_notices").length, 1);
});

test("a linked shift cannot then be picked up by staff", async () => {
  const claim = await loadAppModule<{ POST: Handler }>("app/api/shifts/[id]/claim/route.ts");
  db.rows("shifts")[0].employee_id = null;
  assert.equal((await patch(1, { deal_id: 500 })).status, 200);
  db.signIn(SAM);
  assert.equal((await claim.POST(req("POST", {}), id(1))).status, 403);
  assert.equal(shift(1).employee_id, null);
});

// --- the day's events ---------------------------------------------------------

test("the events route lists a date's booked and marketing events and no others", async () => {
  const res = await eventsRoute.GET(new Request("http://time.test/api?date=2026-10-23"));
  assert.equal(res.status, 200);
  const { events } = await res.json();
  assert.deepEqual(events.map((e: { id: number }) => e.id).sort(), [500, 502, 505]);
  assert.equal(events.find((e: { id: number }) => e.id === 500).name, "Event A");
});

test("the events route needs a real date", async () => {
  const res = await eventsRoute.GET(new Request("http://time.test/api?date=soon"));
  assert.equal(res.status, 400);
});

// --- the events shifts are already linked to ------------------------------------

test("a shift's linked event is read back at any stage, so the popup can show a finished or archived one", async () => {
  const events = await loadLinkedEvents(createClient(), [503, 504]);
  assert.deepEqual(events?.map((e) => e.id).sort(), [503, 504]);
});

test("no linked shifts: no linked events, even when events can't be read", async () => {
  db.missingTables = ["deals"];
  assert.deepEqual(await loadLinkedEvents(createClient(), []), []);
});

test("linked events that can't be read come back as null, not as none", async () => {
  db.missingTables = ["deals"];
  assert.equal(await loadLinkedEvents(createClient(), [500]), null);
});

// --- marketing events are out of a Catering shift's selector and badge -----------

test("a day with only a marketing event offers a Catering shift nothing and badges nothing", async () => {
  const events = await loadScheduleEvents(createClient(), "2026-10-26", "2026-10-26");
  assert.deepEqual(eventsForPosition("Catering", events!), []);
  const covering = { ...PLACED, starts_at: edt("2026-10-26", "11:00"), ends_at: edt("2026-10-26", "15:00") };
  assert.equal(eventBadges([covering], events!, TODAY).size, 0);
});

test("a marketing event beside one Booked event: the Booked event still preselects and is the one the badge suggests", async () => {
  db.tables.deals = [{ ...DEAL }, { ...MARKETING }];
  const onDate = eventsForPosition("Catering", (await loadScheduleEvents(createClient(), "2026-10-23", "2026-10-23"))!);
  assert.deepEqual(onDate.map((e) => e.id), [500]);
  const fitting = fittingEvents(PLACED, onDate);
  assert.equal(eventDropdown({ pick: null, currentDealId: null, currentEvent: null, date: "2026-10-23", onDate, fitting })?.selected, 500);
  const badge = eventBadges([PLACED], onDate, TODAY).get(1);
  assert.equal(badge?.kind === "suggest" && badge.event.id, 500);
});

// --- a Catering shift already linked to a marketing event ------------------------

async function popupFor(linked: number) {
  const onDate = eventsForPosition("Catering", (await loadScheduleEvents(createClient(), "2026-10-23", "2026-10-23"))!);
  const [current] = (await loadLinkedEvents(createClient(), [linked]))!;
  return eventDropdown({ pick: null, currentDealId: linked, currentEvent: current ?? null, date: "2026-10-23", onDate, fitting: fittingEvents(PLACED, onDate) });
}

function linkToMarketing() {
  db.rows("shifts")[0].deal_id = 502;
  db.rows("shifts")[0].deal_slot = 4;
}

test("its popup shows the saved marketing event, selected, though the day does not offer it", async () => {
  linkToMarketing();
  const popup = await popupFor(502);
  assert.equal(popup?.selected, 502);
  assert.equal(popup?.options.find((e) => e.id === 502)?.name, "Event A");
  assert.deepEqual(popup?.options.map((e) => e.id), [500, 505, 502]);
});

test("a save that leaves the dropdown alone keeps the link and the slot, with or without deal_id in the body", async () => {
  linkToMarketing();
  assert.equal((await patch(1, { notes: "bring the cart" })).status, 200);
  assert.equal(shift(1).deal_id, 502);
  assert.equal((await patch(1, { deal_id: 502 })).status, 200);
  assert.equal(shift(1).deal_id, 502);
  assert.equal(shift(1).deal_slot, 4);
});

test("the manager can move it to a Booked event", async () => {
  linkToMarketing();
  assert.equal((await patch(1, { deal_id: 500 })).status, 200);
  assert.equal(shift(1).deal_id, 500);
  assert.equal(shift(1).deal_slot, 1);
});

test("the manager can set it to None", async () => {
  linkToMarketing();
  assert.equal((await patch(1, { deal_id: null })).status, 200);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).deal_slot, null);
});

// --- Marketing shifts ------------------------------------------------------------

const MARKETING_BODY = { position: "Marketing" };

function makeMarketing(over: Record<string, unknown> = {}) {
  Object.assign(db.rows("shifts")[0], { position: "Marketing", deal_id: 502, deal_slot: 4, ...over });
}

test("a Marketing shift is offered that day's marketing events and no booked ones", async () => {
  const onDate = eventsForPosition("Marketing", (await loadScheduleEvents(createClient(), "2026-10-23", "2026-10-23"))!);
  assert.deepEqual(onDate.map((e) => e.id), [502]);
});

test("a Marketing shift covering one marketing event gets it preselected and badged", async () => {
  const placed = { ...PLACED, ...MARKETING_BODY };
  const all = (await loadScheduleEvents(createClient(), "2026-10-23", "2026-10-23"))!;
  const onDate = eventsForPosition("Marketing", all);
  const popup = eventDropdown({ pick: null, currentDealId: null, currentEvent: null, date: "2026-10-23", onDate, fitting: fittingEvents(placed, onDate) });
  assert.equal(popup?.selected, 502);
  const badge = eventBadges([placed], all, TODAY).get(1);
  assert.equal(badge?.kind === "suggest" && badge.event.id, 502);
});

test("saving a marketing event on a Marketing shift writes deal_id and the next free slot", async () => {
  db.rows("shifts")[0].position = "Marketing";
  addLinked({ deal_id: 502, deal_slot: 2, position: "Marketing" });
  assert.equal((await patch(1, { deal_id: 502 })).status, 200);
  assert.equal(shift(1).deal_id, 502);
  assert.equal(shift(1).deal_slot, 3);
});

test("a new Marketing shift can be saved with its event", async () => {
  const res = await shifts.POST(req("POST", newShiftBody({ ...MARKETING_BODY, deal_id: 502 })));
  assert.equal(res.status, 200);
  const { shift: row } = await res.json();
  assert.equal(row.deal_id, 502);
  assert.equal(row.deal_slot, 1);
});

test("a Marketing shift cannot take a booked event, on either route", async () => {
  db.rows("shifts")[0].position = "Marketing";
  assert.equal((await patch(1, { deal_id: 500 })).status, 400);
  assert.equal(shift(1).deal_id, null);
  assert.equal((await shifts.POST(req("POST", newShiftBody({ ...MARKETING_BODY, deal_id: 500 })))).status, 400);
  assert.equal(db.rows("shifts").length, 1);
});

test("None clears a Marketing shift's event and slot", async () => {
  makeMarketing();
  assert.equal((await patch(1, { deal_id: null })).status, 200);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).deal_slot, null);
});

test("moving a linked Marketing shift to another day clears its event", async () => {
  makeMarketing();
  assert.equal((await patch(1, { starts_at: edt("2026-10-25", "11:00"), ends_at: edt("2026-10-25", "15:00") })).status, 200);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).deal_slot, null);
});

test("moving a linked Marketing shift within the day keeps its event", async () => {
  makeMarketing();
  await patch(1, { starts_at: edt("2026-10-23", "10:00") });
  assert.equal(shift(1).deal_id, 502);
  assert.equal(shift(1).deal_slot, 4);
});

test("staff cannot link a Marketing shift", async () => {
  db.rows("shifts")[0].position = "Marketing";
  db.signIn(SAM);
  assert.equal((await patch(1, { deal_id: 502 })).status, 403);
  assert.equal(shift(1).deal_id, null);
});

test("a save that only changes a Marketing shift's event tells nobody", async () => {
  db.rows("shifts")[0].position = "Marketing";
  const res = await patch(1, { employee_id: SAM, location_id: 1, starts_at: PLACED.starts_at, ends_at: PLACED.ends_at, position: "Marketing", notes: null, deal_id: 502 });
  assert.equal(res.status, 200);
  assert.equal(shift(1).deal_id, 502);
  assert.deepEqual(db.rows("shift_notices"), []);
});

test("a past Marketing shift whose deal is now Event Complete keeps its link and slot through unrelated saves", async () => {
  makeMarketing({ deal_id: 503, deal_slot: 2, ...ON_FINISHED_DAY });
  assert.equal((await patch(1, { notes: "bring the table" })).status, 200);
  assert.equal((await patch(1, { deal_id: 503 })).status, 200);
  assert.equal(shift(1).deal_id, 503);
  assert.equal(shift(1).deal_slot, 2);
  assert.equal(shift(1).notes, "bring the table");
  const [saved] = (await loadLinkedEvents(createClient(), [503]))!;
  const onDate = eventsForPosition("Marketing", (await loadScheduleEvents(createClient(), FINISHED_DAY, FINISHED_DAY))!);
  const popup = eventDropdown({ pick: null, currentDealId: 503, currentEvent: saved, savedDate: FINISHED_DAY, date: FINISHED_DAY, onDate, fitting: [] });
  assert.equal(popup?.selected, 503);
  assert.equal(popup?.options.filter((e) => e.id === 503).length, 1);
});

test("a position with no events keeps whatever link it has when moved", async () => {
  Object.assign(db.rows("shifts")[0], { position: "PENN Opener", deal_id: 500, deal_slot: 1 });
  await patch(1, { starts_at: edt("2026-10-25", "11:00"), ends_at: edt("2026-10-25", "15:00") });
  assert.equal(shift(1).deal_id, 500);
});

// --- the names on linked shifts' chips --------------------------------------------

test("a name comes back by deal id: the company, else the contact", async () => {
  assert.deepEqual(await loadEventNames([600, 601]), { 600: "Test Company", 601: "Pat Test" });
});

test("a deal that is missing or has no name is left out, and the rest still come back", async () => {
  assert.deepEqual(await loadEventNames([600, 602, 999]), { 600: "Test Company" });
});

test("no ids and no read; a failed read is no names, not an error", async () => {
  db.missingTables = ["deals"];
  assert.deepEqual(await loadEventNames([]), {});
  assert.deepEqual(await loadEventNames([600]), {});
});

test("a staff session cannot read deals, and still gets the name and only the name", async () => {
  db.signIn(SAM);
  const { data } = await createClient().from("deals").select("id, company").in("id", [600]);
  assert.deepEqual(data, []);
  const names = await loadEventNames([600]);
  assert.deepEqual(names, { 600: "Test Company" });
  assert.doesNotMatch(JSON.stringify(names), /example\.test|555-0100|1234|Pat/);
});

// --- finished events -------------------------------------------------------------

/** Put shift 1 on the finished events' day, at this position and with this person. */
function placeOnFinishedDay(over: Record<string, unknown> = {}) {
  Object.assign(db.rows("shifts")[0], ON_FINISHED_DAY, over);
}

const dayEvents = async () => (await loadScheduleEvents(createClient(), FINISHED_DAY, FINISHED_DAY))!;
const idsFor = async (position: string) => eventsForPosition(position, await dayEvents()).map((e) => e.id).sort();

/** Link another shift to a deal: what makes a finished event one kind or the other. */
function linkToDeal(dealId: number, position: string, employee_id: string | null = SAM) {
  db.rows("shifts").push({ ...PLACED, ...ON_FINISHED_DAY, id: 80 + db.rows("shifts").length, employee_id, position, deal_id: dealId, deal_slot: 10 + db.rows("shifts").length });
}

const asDeal = (over: { event_type?: string } = {}) => ({ ...FINISHED, event_type: null as string | null, ...over });
const linkedShift = (position: string | null, employee_id: string | null, deal_id = 503) => ({ id: 1, employee_id, starts_at: "", ends_at: "", position, deal_id });

test("a finished deal's kind is payroll's answer, then a staffed Catering shift, else both", () => {
  // Marketing, by isMarketingEvent: a Marketing shift linked, whatever it is typed as.
  assert.deepEqual(finishedEventKinds(asDeal({ event_type: "Birthday Party" }), [linkedShift("Marketing", SAM)]), ["marketing"]);
  assert.deepEqual(finishedEventKinds(asDeal(), [linkedShift(" Marketing ", null)]), ["marketing"]);
  // Marketing, by event_type, in any spelling, for one nobody was linked to.
  assert.deepEqual(finishedEventKinds(asDeal({ event_type: "marketing-event" }), []), ["marketing"]);
  // A staffed Catering shift wins over both.
  assert.deepEqual(finishedEventKinds(asDeal({ event_type: "Marketing Event" }), [linkedShift("Marketing", SAM), linkedShift("Catering", SAM)]), ["catering"]);
  assert.deepEqual(finishedEventKinds(asDeal(), [linkedShift("Catering", SAM)]), ["catering"]);
  // An open Catering slot does not count, as it does not in payroll.
  assert.deepEqual(finishedEventKinds(asDeal({ event_type: "Marketing Event" }), [linkedShift("Catering", null)]), ["marketing"]);
  assert.deepEqual(finishedEventKinds(asDeal(), [linkedShift("Catering", null)]), ["catering", "marketing"]);
  // Nothing to go on, and a type that only sounds like one kind is not something.
  assert.deepEqual(finishedEventKinds(asDeal(), []), ["catering", "marketing"]);
  assert.deepEqual(finishedEventKinds(asDeal({ event_type: "Wedding" }), []), ["catering", "marketing"]);
});

test("a finished deal is marketing exactly when payroll says so", async () => {
  const { isMarketingEvent } = await loadAppModule<typeof import("./payroll/verify.ts")>("lib/payroll/verify.ts");
  // Worked out by hand from payroll's rule: a staffed Catering shift says catering,
  // else any Marketing shift says marketing, else event_type decides.
  const untyped = asDeal();
  const typed = asDeal({ event_type: "Marketing Event" });
  const wedding = asDeal({ event_type: "Wedding" });
  const cases: [string, ReturnType<typeof linkedShift>[], [boolean, boolean, boolean]][] = [
    ["no shifts", [], [false, true, false]],
    ["a staffed Marketing shift", [linkedShift("Marketing", SAM)], [true, true, true]],
    ["an open Marketing shift", [linkedShift("Marketing", null)], [true, true, true]],
    ["a staffed Catering shift", [linkedShift("Catering", SAM)], [false, false, false]],
    ["an open Catering shift", [linkedShift("Catering", null)], [false, true, false]],
    ["staffed Marketing and staffed Catering", [linkedShift("Marketing", SAM), linkedShift("Catering", SAM)], [false, false, false]],
    ["staffed Marketing and open Catering", [linkedShift("Marketing", SAM), linkedShift("Catering", null)], [true, true, true]],
  ];
  for (const [label, shifts, expected] of cases) {
    [untyped, typed, wedding].forEach((deal, i) => {
      const where = `${label}, event_type ${deal.event_type}`;
      assert.equal(finishedEventKinds(deal, shifts).join() === "marketing", expected[i], where);
      assert.equal(isMarketingEvent({ ...deal, staff_count: null }, shifts), expected[i], `payroll: ${where}`);
    });
  }
});

test("the day's read lists finished events, with what each is for; Closed Lost and archived stay out", async () => {
  linkToDeal(503, "Catering");
  const events = await dayEvents();
  assert.deepEqual(events.map((e) => e.id).sort(), [503, 510]);
  assert.deepEqual(events.find((e) => e.id === 503)?.finished_for, ["catering"]);
  assert.deepEqual(events.find((e) => e.id === 510)?.finished_for, ["marketing"]);
});

test("the events route gives a date's finished events their kinds, and no shift or event_type reaches the browser", async () => {
  linkToDeal(503, "Catering");
  const res = await eventsRoute.GET(new Request(`http://time.test/api?date=${FINISHED_DAY}`));
  assert.equal(res.status, 200);
  const { events } = await res.json();
  assert.deepEqual(events.map((e: { id: number }) => e.id).sort(), [503, 510]);
  assert.deepEqual(events.find((e: { id: number }) => e.id === 503).finished_for, ["catering"]);
  assert.deepEqual(Object.keys(events.find((e: { id: number }) => e.id === 510)).sort(), ["event_date", "event_end_time", "event_start_time", "finished_for", "id", "name", "stage"]);
});

test("another deal's shifts say nothing about this one", async () => {
  linkToDeal(510, "Catering");
  assert.deepEqual((await dayEvents()).find((e) => e.id === 503)?.finished_for, ["catering", "marketing"]);
});

test("a Catering shift lists finished catering events, a Marketing shift finished marketing events", async () => {
  linkToDeal(503, "Catering");
  assert.deepEqual(await idsFor("Catering"), [503]);
  assert.deepEqual(await idsFor("Marketing"), [510]);
});

test("a finished event nothing says the kind of shows for both, and a position with no events still sees nothing", async () => {
  assert.deepEqual(await idsFor("Catering"), [503]);
  assert.deepEqual(await idsFor("Marketing"), [503, 510]);
  assert.deepEqual(await idsFor("PENN Opener"), []);
});

test("a finished event a Catering shift covers is preselected", async () => {
  placeOnFinishedDay();
  const onDate = eventsForPosition("Catering", await dayEvents());
  const popup = eventDropdown({ pick: null, currentDealId: null, currentEvent: null, date: FINISHED_DAY, onDate, fitting: fittingEvents(shift(1) as never, onDate) });
  assert.equal(popup?.selected, 503);
});

test("the server links a Catering shift to a finished catering event, on the next free slot", async () => {
  placeOnFinishedDay();
  linkToDeal(503, "Catering");
  const res = await patch(1, { deal_id: 503 });
  assert.equal(res.status, 200);
  assert.equal(shift(1).deal_id, 503);
  assert.equal(shift(1).deal_slot, 12);
});

test("the server links a Marketing shift to a finished marketing event", async () => {
  placeOnFinishedDay({ position: "Marketing" });
  assert.equal((await patch(1, { deal_id: 510 })).status, 200);
  assert.equal(shift(1).deal_id, 510);
});

test("the server links either position to a finished event nothing says the kind of", async () => {
  placeOnFinishedDay();
  assert.equal((await patch(1, { deal_id: 503 })).status, 200);
  assert.equal(shift(1).deal_id, 503);

  db.rows("shifts")[0].deal_id = null;
  db.rows("shifts")[0].deal_slot = null;
  placeOnFinishedDay({ position: "Marketing" });
  assert.equal((await patch(1, { deal_id: 503 })).status, 200);
  assert.equal(shift(1).deal_id, 503);
});

test("the server refuses a finished event of the other kind, on both routes", async () => {
  placeOnFinishedDay();
  assert.equal((await patch(1, { deal_id: 510 })).status, 400);
  assert.equal(shift(1).deal_id, null);
  const refused = await shifts.POST(req("POST", newShiftBody({ ...ON_FINISHED_DAY, deal_id: 510 })));
  assert.equal(refused.status, 400);

  linkToDeal(503, "Catering");
  placeOnFinishedDay({ position: "Marketing" });
  assert.equal((await patch(1, { deal_id: 503 })).status, 400);
  assert.equal(shift(1).deal_id, null);
});

test("the server refuses a shift on another day from the finished event", async () => {
  assert.equal((await patch(1, { deal_id: 503 })).status, 400);
  assert.equal(shift(1).deal_id, null);
});

test("Closed Lost is refused for both positions, and so is every stage that isn't an event, and an archived finished one", async () => {
  placeOnFinishedDay();
  assert.equal((await patch(1, { deal_id: 507 })).status, 400);
  assert.equal((await patch(1, { deal_id: 511 })).status, 400);
  for (const stage of ["Closed Below Min", "Open", "Sent Quote", "Quote Review"]) {
    db.rows("deals").find((d) => d.id === 507)!.stage = stage;
    assert.equal((await patch(1, { deal_id: 507 })).status, 400, stage);
  }
  db.rows("deals").find((d) => d.id === 507)!.stage = "Closed Lost";
  placeOnFinishedDay({ position: "Marketing" });
  assert.equal((await patch(1, { deal_id: 507 })).status, 400);
  assert.equal(shift(1).deal_id, null);
});

test("staff cannot link a finished event", async () => {
  placeOnFinishedDay();
  db.signIn(SAM);
  assert.equal((await patch(1, { deal_id: 503 })).status, 403);
  assert.equal(shift(1).deal_id, null);
});

test("None clears a finished event's link, and a date move takes the shift off it", async () => {
  placeOnFinishedDay({ deal_id: 503, deal_slot: 2 });
  assert.equal((await patch(1, { deal_id: null })).status, 200);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).deal_slot, null);

  placeOnFinishedDay({ deal_id: 503, deal_slot: 2 });
  assert.equal((await patch(1, { starts_at: edt("2026-10-29", "11:00"), ends_at: edt("2026-10-29", "15:00") })).status, 200);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).deal_slot, null);
});

test("saving the finished event a shift already has keeps its slot, even once its kind has turned", async () => {
  placeOnFinishedDay({ position: "Marketing", deal_id: 503, deal_slot: 2 });
  linkToDeal(503, "Catering");
  assert.equal((await patch(1, { deal_id: 503 })).status, 200);
  assert.equal(shift(1).deal_id, 503);
  assert.equal(shift(1).deal_slot, 2);
});

test("the linked shifts can't be read: the schedule read is null, not a guess", async () => {
  db.missingTables = ["shifts"];
  assert.equal(await loadScheduleEvents(createClient(), FINISHED_DAY, FINISHED_DAY), null);
});

test("no finished event on the dates: the shifts are not read at all", async () => {
  db.missingTables = ["shifts"];
  const events = await loadScheduleEvents(createClient(), "2026-10-23", "2026-10-23");
  assert.deepEqual(events?.map((e) => e.id).sort(), [500, 502, 505]);
});

test("the linked shifts can't be read on a save: it answers 503 and links nothing", async () => {
  db.missingTables = ["shifts"];
  const plan = await planEventLink(createClient(), { requested: 503, before: { deal_id: null, starts_at: ON_FINISHED_DAY.starts_at }, startsAt: ON_FINISHED_DAY.starts_at, position: "Catering" });
  assert.deepEqual(plan, { ok: false, status: 503, error: "Couldn't read that event. Try again in a moment." });
});

test("the person left behind keeps their badge when the event finishes, and it goes once they are linked", async () => {
  // Two on the event, one linked, and the deal then reaches Event Complete.
  placeOnFinishedDay();
  linkToDeal(503, "Catering", MANAGER);
  const schedule = () => db.rows("shifts") as never as Parameters<typeof eventBadges>[0];

  const badges = eventBadges(schedule(), await dayEvents(), TODAY);
  assert.deepEqual([...badges.keys()], [1]);
  const badge = badges.get(1);
  assert.equal(badge?.kind === "suggest" && badge.event.id, 503);

  assert.equal((await patch(1, { deal_id: 503 })).status, 200);
  assert.equal(eventBadges(schedule(), await dayEvents(), TODAY).size, 0);
});

test("the same goes for a Marketing crew: the colleague's link is what says it is marketing", async () => {
  placeOnFinishedDay({ position: "Marketing" });
  linkToDeal(503, "Marketing", MANAGER);
  const badge = eventBadges(db.rows("shifts") as never, await dayEvents(), TODAY).get(1);
  assert.equal(badge?.kind, "choose"); // this one and the typed marketing event both fit
  assert.equal((await patch(1, { deal_id: 503 })).status, 200);
});

test("an event finished more than 14 days ago badges nobody and can still be linked from the popup", async () => {
  placeOnFinishedDay();
  const events = await dayEvents();
  assert.equal(eventBadges([shift(1)] as never, events, "2026-11-11").size, 1);
  assert.equal(eventBadges([shift(1)] as never, events, "2026-11-12").size, 0);
  assert.deepEqual(eventsForPosition("Catering", events).map((e) => e.id), [503]);
  assert.equal((await patch(1, { deal_id: 503 })).status, 200);
});
