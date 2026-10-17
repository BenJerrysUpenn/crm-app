// Who manager alerts name, driven through the real route handlers
// (bj-finance #468): a person whose profile name is missing, or is still the
// login email a pre-migration_21 row was given, appears as "An employee" in the
// alert managers receive, never as the email. A named person appears by name.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts. The alert is read back from
// the notifications table, which is what the managers' in-app inbox shows.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;
const week = await loadAppModule<{ PUT: Handler }>("app/api/availability/week/route.ts");
const drop = await loadAppModule<{ POST: Handler }>("app/api/shifts/[id]/drop/route.ts");

const BOSS = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const OLD = "00000000-0000-0000-0000-00000000000c"; // pre-migration_21: email as name
const NONE = "00000000-0000-0000-0000-00000000000d"; // no name at all
const WEEK = "2026-09-27"; // Sunday

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: BOSS, role: "manager", active: true, full_name: "Alex Boss", phone: null, notif_prefs: {} },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee" },
      { id: OLD, role: "employee", active: true, full_name: "staff2@example.com" },
      { id: NONE, role: "employee", active: true, full_name: null },
    ],
    shifts: [
      { id: "shift-old", employee_id: OLD, starts_at: "2026-09-29T14:00:00Z", ends_at: "2026-09-29T18:00:00Z", position: null, published: true },
    ],
    shift_requests: [],
    availability: [],
    notifications: [],
  });
});

function saveWeek(): Promise<Response> {
  return week.PUT(
    new Request("http://time.test/api/availability/week", {
      method: "PUT",
      body: JSON.stringify({ weekStart: WEEK, blocks: [] }),
    }),
    { params: { id: "" } },
  );
}

function bossAlerts(): string[] {
  return db.rows("notifications").filter((n) => n.user_id === BOSS).map((n) => String(n.body));
}

test("a named person's availability update names them to managers", async () => {
  db.signIn(SAM);
  const res = await saveWeek();
  assert.equal(res.status, 200);
  assert.deepEqual(bossAlerts(), ["Sam Lee updated their availability."]);
});

test("an email sitting in the name never reaches the manager's alert", async () => {
  db.signIn(OLD);
  const res = await saveWeek();
  assert.equal(res.status, 200);
  assert.deepEqual(bossAlerts(), ["An employee updated their availability."]);
});

test("a person with no name is 'An employee' in the alert", async () => {
  db.signIn(NONE);
  const res = await saveWeek();
  assert.equal(res.status, 200);
  assert.deepEqual(bossAlerts(), ["An employee updated their availability."]);
});

test("a drop request from someone whose name is their email says 'An employee wants to drop'", async () => {
  db.signIn(OLD);
  const res = await drop.POST(
    new Request("http://time.test/api/shifts/shift-old/drop", { method: "POST", body: "{}" }),
    { params: { id: "shift-old" } },
  );
  assert.equal(res.status, 200);
  const alerts = bossAlerts();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /^An employee wants to drop /);
  assert.doesNotMatch(alerts[0], /staff2@example\.com/);
});

// ---- the other alerts the PR moved onto displayName -------------------------
// Each route below used `full_name ?? "An employee"` (the cron: "Employee"),
// which let an email sitting in the name through. One test per route, through
// its handler, with the pre-migration_21 person as the sender.

const claim = await loadAppModule<{ POST: Handler }>("app/api/shifts/[id]/claim/route.ts");
const pickup = await loadAppModule<{ POST: Handler }>("app/api/shifts/[id]/request-pickup/route.ts");
const availability = await loadAppModule<{ POST: Handler }>("app/api/availability/route.ts");
const availabilityById = await loadAppModule<{ DELETE: Handler }>("app/api/availability/[id]/route.ts");
const cron = await loadAppModule<{ GET: (request: Request) => Promise<Response> }>(
  "app/api/cron/missed-clockins/route.ts",
);

function openShift(id: string) {
  db.tables.shifts.push({
    id,
    employee_id: null,
    starts_at: "2026-09-30T14:00:00Z",
    ends_at: "2026-09-30T18:00:00Z",
    position: null,
    published: true,
    deal_id: null,
  });
}

function onlyAlert(): string {
  const alerts = bossAlerts();
  assert.equal(alerts.length, 1, `one alert to the manager: ${JSON.stringify(alerts)}`);
  return alerts[0];
}

test("an open shift claimed by someone whose name is their email is 'An employee picked up'", async () => {
  openShift("shift-open");
  db.signIn(OLD);
  const res = await claim.POST(new Request("http://time.test/api/shifts/shift-open/claim", { method: "POST" }), {
    params: { id: "shift-open" },
  });
  assert.equal(res.status, 200);
  const alert = onlyAlert();
  assert.match(alert, /^An employee picked up /);
  assert.doesNotMatch(alert, /staff2@example\.com/);
});

test("a pickup request from someone whose name is their email is 'An employee wants'", async () => {
  openShift("shift-open");
  db.signIn(OLD);
  const res = await pickup.POST(
    new Request("http://time.test/api/shifts/shift-open/request-pickup", { method: "POST", body: "{}" }),
    { params: { id: "shift-open" } },
  );
  assert.equal(res.status, 200);
  const alert = onlyAlert();
  assert.match(alert, /^An employee wants /);
  assert.doesNotMatch(alert, /staff2@example\.com/);
});

test("a time-off request from someone whose name is their email is 'An employee requested time off'", async () => {
  db.tables.annotations = [];
  db.signIn(OLD);
  const res = await availability.POST(
    new Request("http://time.test/api/availability", {
      method: "POST",
      body: JSON.stringify({ start_date: "2099-03-02", end_date: "2099-03-02" }),
    }),
    { params: { id: "" } },
  );
  assert.equal(res.status, 200);
  const alert = onlyAlert();
  assert.match(alert, /^An employee requested time off for /);
  assert.doesNotMatch(alert, /staff2@example\.com/);
});

test("a named person's time-off request names them", async () => {
  db.tables.annotations = [];
  db.signIn(SAM);
  const res = await availability.POST(
    new Request("http://time.test/api/availability", {
      method: "POST",
      body: JSON.stringify({ start_date: "2099-03-02", end_date: "2099-03-02" }),
    }),
    { params: { id: "" } },
  );
  assert.equal(res.status, 200);
  assert.match(onlyAlert(), /^Sam Lee requested time off for /);
});

test("a single availability preference saved by someone whose name is their email is 'An employee updated'", async () => {
  db.signIn(OLD);
  const res = await availability.POST(
    new Request("http://time.test/api/availability", {
      method: "POST",
      body: JSON.stringify({ weekday: 2, start_time: "09:00", end_time: "17:00", preference: "preferred" }),
    }),
    { params: { id: "" } },
  );
  assert.equal(res.status, 200);
  assert.equal(onlyAlert(), "An employee updated their availability.");
});

test("cancelling approved time off, for someone whose name is their email, is 'An employee removed'", async () => {
  db.tables.availability.push({
    id: "off-1",
    employee_id: OLD,
    specific_date: "2099-03-02",
    is_available: false,
    status: "approved",
    request_group: null,
  });
  db.signIn(OLD);
  const res = await availabilityById.DELETE(new Request("http://time.test/api/availability/off-1", { method: "DELETE" }), {
    params: { id: "off-1" },
  });
  assert.equal(res.status, 200);
  const alert = onlyAlert();
  assert.match(alert, /^An employee removed their approved time off for /);
  assert.doesNotMatch(alert, /staff2@example\.com/);
});

// The cron reads the shift with its person embedded (profiles(full_name, phone));
// the fake does not join, so the shift row carries the embed as PostgREST returns it.
function lateShift(id: number, employee: string, fullName: string | null) {
  db.tables.shifts.push({
    id,
    employee_id: employee,
    starts_at: new Date(Date.now() - 30 * 60000).toISOString(),
    ends_at: new Date(Date.now() + 3 * 3600000).toISOString(),
    position: null,
    published: true,
    profiles: { full_name: fullName, phone: null },
  });
}

async function runCron() {
  db.tables.time_entries = [];
  db.tables.shift_notices = [];
  db.tables.shift_digests = [];
  const res = await cron.GET(new Request("http://time.test/api/cron/missed-clockins"));
  assert.equal(res.status, 200);
}

test("a missed clock-in by someone whose name is their email tells managers 'An employee hasn't clocked in'", async () => {
  lateShift(41, OLD, "staff2@example.com");
  await runCron();
  const alert = onlyAlert();
  assert.match(alert, /^An employee hasn't clocked in for the /);
  assert.doesNotMatch(alert, /staff2@example\.com/);
});

test("a missed clock-in by someone with no name says 'An employee', not 'Employee'", async () => {
  lateShift(42, NONE, null);
  await runCron();
  assert.match(onlyAlert(), /^An employee hasn't clocked in for the /);
});

test("a missed clock-in by a named person names them to managers", async () => {
  lateShift(43, SAM, "Sam Lee");
  await runCron();
  assert.match(onlyAlert(), /^Sam Lee hasn't clocked in for the /);
});
