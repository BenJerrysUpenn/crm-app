// Saving a shift's Catering event through the shift routes: who may, which slot
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
const eventsRoute = await loadAppModule<{ GET: (request: Request) => Promise<Response> }>("app/api/schedule/catering-events/route.ts");

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
const FINISHED = { ...DEAL, id: 503, stage: "Event Complete" };
const ARCHIVED = { ...DEAL, id: 504, archived: 1 };

// Shift 1: on a person, placed on the page, no event yet.
const PLACED = { id: 1, employee_id: SAM, location_id: 1, starts_at: edt("2026-10-23", "11:00"), ends_at: edt("2026-10-23", "15:00"), position: "Catering", notes: null, published: true, deal_id: null, deal_slot: null };

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: OWNER, role: "owner", active: true, full_name: "Test Owner", phone: null },
      { id: MANAGER, role: "manager", active: true, full_name: "Test Manager", phone: null },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee", phone: null },
    ],
    shifts: [{ ...PLACED }],
    deals: [{ ...DEAL }, { ...OTHER_DAY }, { ...MARKETING }, { ...FINISHED }, { ...ARCHIVED }],
    shift_requests: [],
    shift_notices: [],
    availability: [],
    notifications: [],
  });
  db.signIn(MANAGER);
});

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

test("a Closed Marketing Event can be linked", async () => {
  assert.equal((await patch(1, { deal_id: 502 })).status, 200);
  assert.equal(shift(1).deal_id, 502);
});

test("switching events takes a slot on the new one", async () => {
  await patch(1, { deal_id: 500 });
  addLinked({ deal_id: 502, deal_slot: 1 });
  assert.equal((await patch(1, { deal_id: 502 })).status, 200);
  assert.equal(shift(1).deal_id, 502);
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

test("a linked Marketing shift keeps its link when moved: it is what marks a marketing event", async () => {
  db.rows("shifts")[0].position = "Marketing";
  db.rows("shifts")[0].deal_id = 502;
  db.rows("shifts")[0].deal_slot = 1;
  await patch(1, { starts_at: edt("2026-10-25", "11:00"), ends_at: edt("2026-10-25", "15:00") });
  assert.equal(shift(1).deal_id, 502);
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

test("a shift that isn't Catering cannot take an event", async () => {
  const res = await patch(1, { position: "PENN Opener", deal_id: 500 });
  assert.equal(res.status, 400);
  assert.equal(shift(1).deal_id, null);
  assert.equal(shift(1).position, "Catering");
});

test("a finished, archived or missing event is refused", async () => {
  assert.equal((await patch(1, { deal_id: 503 })).status, 400);
  assert.equal((await patch(1, { deal_id: 504 })).status, 400);
  assert.equal((await patch(1, { deal_id: 999 })).status, 400);
  assert.equal(shift(1).deal_id, null);
});

test("a deal_id that is not an id is refused", async () => {
  assert.equal((await patch(1, { deal_id: "500" })).status, 400);
  assert.equal((await shifts.POST(req("POST", newShiftBody({ deal_id: -1 })))).status, 400);
  assert.equal(shift(1).deal_id, null);
});

// --- leaving everything else alone --------------------------------------------

test("an edit with no deal_id leaves the link alone", async () => {
  db.rows("shifts")[0].deal_id = 500;
  db.rows("shifts")[0].deal_slot = 3;
  await patch(1, { notes: "bring the cart" });
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

test("the events route lists a date's booked events and no others", async () => {
  const res = await eventsRoute.GET(new Request("http://time.test/api?date=2026-10-23"));
  assert.equal(res.status, 200);
  const { events } = await res.json();
  assert.deepEqual(events.map((e: { id: number }) => e.id).sort(), [500, 502]);
  assert.equal(events.find((e: { id: number }) => e.id === 500).name, "Event A");
});

test("the events route needs a real date", async () => {
  const res = await eventsRoute.GET(new Request("http://time.test/api?date=soon"));
  assert.equal(res.status, 400);
});
