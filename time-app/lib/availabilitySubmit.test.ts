// Submitting availability and time off, driven through the real route handlers.
//
// Shifts are published the moment they are saved, so a published shift no
// longer locks a day: an employee can still request it off or repaint it.
// What still stops a request is a day that has passed, or one a manager
// marked "no time off".
//
// Dates are far from today on purpose: the routes read the real clock, so a
// "future" day is in 2099 and a "past" day is in 2000.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request) => Promise<Response>;

const availability = await loadAppModule<{ POST: Handler }>("app/api/availability/route.ts");
const week = await loadAppModule<{ PUT: Handler }>("app/api/availability/week/route.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const JO = "00000000-0000-0000-0000-00000000000c";

const WEEK = "2099-06-07"; // Sunday
const MON = "2099-06-08";
const TUE = "2099-06-09";
const WED = "2099-06-10";
const PAST = "2000-01-03";

function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}
function req(method: string, body: unknown): Request {
  return new Request("http://time.test/api/availability", { method, body: JSON.stringify(body) });
}
function published(id: number, employee_id: string, date: string) {
  return { id, employee_id, starts_at: edt(date, "12:00"), ends_at: edt(date, "17:00"), published: true };
}
const samDays = () =>
  db
    .rows("availability")
    .filter((r) => r.employee_id === SAM)
    .map((r) => r.specific_date)
    .sort();

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Test Owner" },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee" },
      { id: JO, role: "employee", active: true, full_name: "Jo Park" },
    ],
    // Published shifts on Monday (Sam's own) and Tuesday (someone else's).
    shifts: [published(1, SAM, MON), published(2, JO, TUE)],
    availability: [],
    annotations: [],
    notifications: [],
  });
  db.signIn(SAM);
});

// ---- POST /api/availability: a time-off range ----------------------------------

test("time off can be requested on days that already have a published shift", async () => {
  const res = await availability.POST(req("POST", { start_date: MON, end_date: WED }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).days, 3);
  assert.deepEqual(samDays(), [MON, TUE, WED]);
});

test("time off skips a day a manager marked no-time-off and keeps the rest", async () => {
  db.tables.annotations.push({ id: 1, start_date: TUE, end_date: TUE, no_time_off: true });
  const res = await availability.POST(req("POST", { start_date: MON, end_date: WED }));
  assert.equal(res.status, 200);
  assert.deepEqual(samDays(), [MON, WED]);
});

test("a manager's note without no-time-off does not block time off", async () => {
  db.tables.annotations.push({ id: 1, start_date: MON, end_date: WED, no_time_off: false });
  const res = await availability.POST(req("POST", { start_date: MON, end_date: WED }));
  assert.equal(res.status, 200);
  assert.deepEqual(samDays(), [MON, TUE, WED]);
});

test("time off only on blocked or past days is refused with 409 and saves nothing", async () => {
  db.tables.annotations.push({ id: 1, start_date: MON, end_date: TUE, no_time_off: true });
  for (const body of [{ start_date: MON, end_date: TUE }, { start_date: PAST }]) {
    const res = await availability.POST(req("POST", body));
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /past or a manager has blocked time off/);
  }
  assert.deepEqual(samDays(), []);
});

// ---- POST /api/availability: a single preference --------------------------------

test("a preference can be added on a day that already has a published shift", async () => {
  const res = await availability.POST(req("POST", { specific_date: MON, preference: "unavailable" }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).availability.specific_date, MON);
  assert.deepEqual(samDays(), [MON]);
});

test("a preference on a past day is refused with 409", async () => {
  const res = await availability.POST(req("POST", { specific_date: PAST, preference: "unavailable" }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "You can't change availability for a day that's passed.");
  assert.deepEqual(samDays(), []);
});

// ---- PUT /api/availability/week -------------------------------------------------

test("saving a week replaces every day's blocks, including days with a published shift", async () => {
  db.tables.availability.push(
    { id: 101, employee_id: SAM, specific_date: MON, start_time: "09:00", end_time: "12:00", is_available: true, status: "approved", preference: "available" },
    { id: 102, employee_id: SAM, specific_date: WED, start_time: "09:00", end_time: "12:00", is_available: true, status: "approved", preference: "available" },
  );
  const res = await week.PUT(
    req("PUT", {
      weekStart: WEEK,
      blocks: [
        { date: MON, start_time: "13:00", end_time: "18:00", preference: "preferred" },
        { date: TUE, start_time: "10:00", end_time: "14:00" },
      ],
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, inserted: 2 });
  const saved = db
    .rows("availability")
    .filter((r) => r.employee_id === SAM)
    .map((r) => [r.specific_date, r.start_time, r.preference])
    .sort();
  assert.deepEqual(saved, [
    [MON, "13:00", "preferred"],
    [TUE, "10:00", "available"],
  ]);
});
