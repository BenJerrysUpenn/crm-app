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
