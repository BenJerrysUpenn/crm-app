// The Labor Hours Planning inputs' doors on the Targets tab (bj-finance #742):
// store-hours seasons and concession events, which owners
// change and managers view, and closed days, which managers set, as on the
// Team page. An event change is a new revision and never rewrites the old
// one; a season is saved as its seven weekday rows.
//
// These drive the real route handlers against the stand-in Supabase project
// (testing/fakeSupabase.ts). The database's own policies are proven by
// supabase/migration_47_verify.sql. Invented names, dates and figures only.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { DB_NOW, loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request, ctx: { params: { date: string } }) => Promise<Response>;

const seasons = await loadAppModule<{ POST: Handler; DELETE: Handler }>("app/api/payroll/targets/seasons/route.ts");
const concession = await loadAppModule<{ POST: Handler }>("app/api/payroll/targets/concession-events/route.ts");
const closedDays = await loadAppModule<{ POST: Handler }>("app/api/payroll/targets/closed-days/route.ts");
const closedDay = await loadAppModule<{ DELETE: Handler }>("app/api/payroll/targets/closed-days/[date]/route.ts");
const teamExceptions = await loadAppModule<{ POST: Handler }>("app/api/store-hours/exceptions/route.ts");
const teamException = await loadAppModule<{ DELETE: Handler }>("app/api/store-hours/exceptions/[date]/route.ts");

const OWNER = "00000000-0000-0000-0000-0000000000a1";
const MANAGER = "00000000-0000-0000-0000-0000000000b1";
const EMPLOYEE = "00000000-0000-0000-0000-0000000000c1";

const NO_PARAMS = { params: { date: "" } };
const NOTE = { effective_from: "2030-01-01", review_by: "2031-01-01", source: "invented for the test", method: "by hand" };
const SEASON = { name: "Test winter", effective_from: "2030-11-01", opens: "13:00", closes: "21:00", closed_weekdays: [1], review_by: "2031-03-01", source: "invented" };
const EXPO = { name: "Test Expo", start_date: "2030-12-01", end_date: "2030-12-03", expected_net_sales: 300, ...NOTE };

function call(method: string, path: string, body?: unknown): Request {
  return new Request(`http://finance.test/api/payroll/targets/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: OWNER, role: "owner", active: false, full_name: "Owner One" },
      { id: MANAGER, role: "manager", active: true, full_name: "Store Manager" },
      { id: EMPLOYEE, role: "employee", active: true, full_name: "Sam Lee" },
    ],
    store_hours_seasons: [],
    concession_events: [],
    store_hours_exceptions: [],
  });
});

// ---- seasons ----------------------------------------------------------------------------

test("an owner saves a season as its seven weekday rows", async () => {
  db.signIn(OWNER);
  const res = await seasons.POST(call("POST", "seasons", SEASON), NO_PARAMS);
  assert.equal(res.status, 200);
  const rows = db.rows("store_hours_seasons");
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.find((r) => r.weekday === 1), {
    effective_from: "2030-11-01", weekday: 1, name: "Test winter", is_closed: true, opens: null, closes: null,
    review_by: "2031-03-01", source: "invented", method: null, id: 2,
  });
  assert.deepEqual([rows[0].opens, rows[0].closes], ["13:00:00", "21:00:00"]);
});

test("saving a season with the same first day again replaces it; removing it takes all seven days", async () => {
  db.signIn(OWNER);
  await seasons.POST(call("POST", "seasons", SEASON), NO_PARAMS);
  await seasons.POST(call("POST", "seasons", { ...SEASON, opens: "12:00", closed_weekdays: [] }), NO_PARAMS);
  const rows = db.rows("store_hours_seasons");
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.opens === "12:00:00" && !r.is_closed));
  const gone = await seasons.DELETE(call("DELETE", "seasons?from=2030-11-01"), NO_PARAMS);
  assert.equal(gone.status, 200);
  assert.equal(db.rows("store_hours_seasons").length, 0);
});

test("a manager who is not an owner cannot add or remove a season, and nothing changes", async () => {
  db.signIn(OWNER);
  await seasons.POST(call("POST", "seasons", SEASON), NO_PARAMS);
  db.signIn(MANAGER);
  const add = await seasons.POST(call("POST", "seasons", { ...SEASON, effective_from: "2031-04-01" }), NO_PARAMS);
  assert.equal(add.status, 403);
  assert.match((await add.json()).error, /Only an owner/);
  assert.equal((await seasons.DELETE(call("DELETE", "seasons?from=2030-11-01"), NO_PARAMS)).status, 403);
  assert.equal(db.rows("store_hours_seasons").length, 7);
  db.signIn(EMPLOYEE);
  assert.equal((await seasons.POST(call("POST", "seasons", SEASON), NO_PARAMS)).status, 403);
});

test("a season that does not make sense is refused with the reason, and before migration 47 it says so", async () => {
  db.signIn(OWNER);
  const bad = await seasons.POST(call("POST", "seasons", { ...SEASON, opens: "22:00" }), NO_PARAMS);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /close after it opens/);
  assert.equal((await seasons.DELETE(call("DELETE", "seasons?from=soon"), NO_PARAMS)).status, 400);
  db.missingTables.push("store_hours_seasons");
  const before = await seasons.POST(call("POST", "seasons", SEASON), NO_PARAMS);
  assert.equal(before.status, 503);
  assert.match((await before.json()).error, /migration 47/);
});

// ---- events -----------------------------------------------------------------------------

test("an owner adds a concession event, stamped in the owner's name, with a key from its name", async () => {
  db.signIn(OWNER);
  const res = await concession.POST(call("POST", "concession-events", { ...EXPO, provisional: true }), NO_PARAMS);
  assert.equal(res.status, 200);
  const { event } = await res.json();
  assert.equal(event.event_key, "test-expo-2030");
  assert.deepEqual(
    db.rows("concession_events").map((r) => [r.event_key, r.name, r.expected_net_sales, r.provisional, r.cancelled, r.effective_from, r.recorded_by, r.recorded_at]),
    [["test-expo-2030", "Test Expo", 300, true, false, "2030-01-01", OWNER, DB_NOW]],
  );
});

test("changing an event adds a revision under its key; the old one stays as history", async () => {
  db.signIn(OWNER);
  await concession.POST(call("POST", "concession-events", EXPO), NO_PARAMS);
  const res = await concession.POST(call("POST", "concession-events", { ...EXPO, event_key: "test-expo-2030", expected_net_sales: 450, effective_from: "2030-06-01" }), NO_PARAMS);
  assert.equal(res.status, 200);
  const off = await concession.POST(call("POST", "concession-events", { ...EXPO, event_key: "test-expo-2030", cancelled: true, effective_from: "2030-07-01" }), NO_PARAMS);
  assert.equal(off.status, 200);
  assert.deepEqual(
    db.rows("concession_events").map((r) => [r.event_key, r.expected_net_sales, r.cancelled, r.effective_from]),
    [["test-expo-2030", 300, false, "2030-01-01"], ["test-expo-2030", 450, false, "2030-06-01"], ["test-expo-2030", 300, true, "2030-07-01"]],
  );
  // A second event of the same name and year gets its own key.
  await concession.POST(call("POST", "concession-events", EXPO), NO_PARAMS);
  assert.equal(db.rows("concession_events")[3].event_key, "test-expo-2030-2");
});

test("a revision of an event that is not on file is refused", async () => {
  db.signIn(OWNER);
  const res = await concession.POST(call("POST", "concession-events", { ...EXPO, event_key: "no-such-event" }), NO_PARAMS);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /No such event/);
  assert.equal(db.rows("concession_events").length, 0);
});

test("a manager who is not an owner, or an employee, cannot add an event", async () => {
  for (const who of [MANAGER, EMPLOYEE]) {
    db.signIn(who);
    const refused = await concession.POST(call("POST", "concession-events", EXPO), NO_PARAMS);
    assert.equal(refused.status, 403);
    if (who === MANAGER) assert.match((await refused.json()).error, /Only an owner/);
  }
  assert.equal(db.rows("concession_events").length, 0);
});

test("before migration 47 the event routes say they need it", async () => {
  db.missingTables.push("concession_events");
  db.signIn(OWNER);
  const res = await concession.POST(call("POST", "concession-events", EXPO), NO_PARAMS);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /migration 47/);
});

// ---- closed days ------------------------------------------------------------------------

test("a manager closes a day from the Targets tab and opens it again; the Team page sees the same row", async () => {
  db.signIn(MANAGER);
  const res = await closedDays.POST(call("POST", "closed-days", { date: "2030-11-28", label: "Thanksgiving", is_closed: true }), NO_PARAMS);
  assert.equal(res.status, 200);
  assert.deepEqual(
    db.rows("store_hours_exceptions").map((r) => [r.date, r.label, r.is_closed, r.opens, r.closes]),
    [["2030-11-28", "Thanksgiving", true, null, null]],
  );
  // The Team page's own door edits the same date in place.
  await teamExceptions.POST(new Request("http://time.test/api/store-hours/exceptions", { method: "POST", body: JSON.stringify({ date: "2030-11-28", label: "Thanksgiving (moved)" }) }), NO_PARAMS);
  assert.deepEqual(db.rows("store_hours_exceptions").map((r) => r.label), ["Thanksgiving (moved)"]);
  const gone = await closedDay.DELETE(call("DELETE", "closed-days/2030-11-28"), { params: { date: "2030-11-28" } });
  assert.equal(gone.status, 200);
  assert.equal(db.rows("store_hours_exceptions").length, 0);
});

test("an employee cannot close or open a day by either door", async () => {
  db.signIn(MANAGER);
  await closedDays.POST(call("POST", "closed-days", { date: "2030-12-25" }), NO_PARAMS);
  db.signIn(EMPLOYEE);
  assert.equal((await closedDays.POST(call("POST", "closed-days", { date: "2031-01-01" }), NO_PARAMS)).status, 403);
  assert.equal((await closedDay.DELETE(call("DELETE", "closed-days/2030-12-25"), { params: { date: "2030-12-25" } })).status, 403);
  assert.equal((await teamException.DELETE(new Request("http://time.test/x", { method: "DELETE" }), { params: { date: "2030-12-25" } })).status, 403);
  assert.deepEqual(db.rows("store_hours_exceptions").map((r) => r.date), ["2030-12-25"]);
});

test("a closed day needs a real date", async () => {
  db.signIn(MANAGER);
  const res = await closedDays.POST(call("POST", "closed-days", { date: "2030-02-30" }), NO_PARAMS);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /real date/);
});
