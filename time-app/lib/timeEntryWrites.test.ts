// Who may write a punch (audit H1, migration 30).
//
// Migration 30 takes insert and update on time_entries away from employees'
// own sessions: through RLS only a manager may write one. The writes an
// employee sets off (clocking in or out, snoozing or dismissing the clock-out
// nudge) must still work, so those routes write with the service role after
// their own checks. A route that wrote through the signed-in session instead
// would work for a manager and fail for everyone else, which on the clock is a
// person at the counter who cannot clock in.
//
// These drive the real route handlers against a stand-in Supabase project that
// refuses an employee's own punch writes the way migration 30 does (see
// testing/fakeSupabase.ts). The database half (the policies themselves, the
// claim guard, the Pi's service-role writes) is supabase/migration_30_verify.sql.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, DB_NOW, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;

const clock = await loadAppModule<{ POST: Handler }>("app/api/clock/route.ts");
const reminder = await loadAppModule<{ POST: Handler }>(
  "app/api/time-entries/[id]/clockout-reminder/route.ts",
);
const timesheet = await loadAppModule<{ POST: Handler }>("app/api/time-entries/route.ts");
const timesheetEntry = await loadAppModule<{ PATCH: Handler; DELETE: Handler }>(
  "app/api/time-entries/[id]/route.ts",
);

const EMPLOYEE = "00000000-0000-0000-0000-00000000000b";
const MANAGER = "00000000-0000-0000-0000-00000000000a";
// The shop, and a spot about 1.1 km north of it.
const SHOP = { lat: 39.9522, lng: -75.1932 };
const FAR = { lat: 39.9622, lng: -75.1932 };

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: false, full_name: "Test Owner" },
      { id: EMPLOYEE, role: "employee", active: true, full_name: "Test Employee" },
    ],
    locations: [
      { id: 1, name: "the shop", latitude: SHOP.lat, longitude: SHOP.lng, radius_meters: 150, is_default: true },
    ],
    clockin_reminders: [],
    clockin_reminder_acks: [],
    shifts: [],
    time_entries: [],
    app_settings: [],
  });
});

function post(body: unknown): Request {
  return new Request("http://time.test/api", { method: "POST", body: JSON.stringify(body) });
}

const noParams = { params: { id: "" } };

function openEntry() {
  const entry = {
    id: 7,
    employee_id: EMPLOYEE,
    clock_in_at: "2026-09-28T13:00:00.000Z",
    clock_out_at: null,
    status: "open",
    clockout_reminder_snoozed_until: null,
    clockout_reminder_dismissed_at: null,
  };
  db.tables.time_entries.push(entry);
  return entry;
}

// ---- /api/clock -------------------------------------------------------------

test("an employee at the shop clocks in, stamped with the database's time, not one they sent", async () => {
  db.signIn(EMPLOYEE);

  const res = await clock.POST(
    post({ action: "in", ...SHOP, accuracy: 8, clock_in_at: "2026-09-28T06:00:00.000Z" }),
    noParams,
  );

  assert.equal(res.status, 200);
  const punches = db.rows("time_entries");
  assert.equal(punches.length, 1);
  assert.equal(punches[0].employee_id, EMPLOYEE);
  assert.equal(punches[0].status, "open");
  assert.equal(punches[0].clock_in_at, DB_NOW);
});

test("an employee with an unacknowledged clock-in reminder is refused, and no punch is written", async () => {
  db.tables.clockin_reminders.push({ id: 3, active: true, created_at: "2026-09-01T00:00:00Z", body: "Wash hands" });
  db.signIn(EMPLOYEE);

  const res = await clock.POST(post({ action: "in", ...SHOP }), noParams);

  assert.equal(res.status, 428);
  assert.deepEqual(db.rows("time_entries"), []);
});

test("an employee outside the geofence is refused, and no punch is written", async () => {
  db.signIn(EMPLOYEE);

  const res = await clock.POST(post({ action: "in", ...FAR }), noParams);

  assert.equal(res.status, 403);
  assert.deepEqual(db.rows("time_entries"), []);
});

test("an employee clocks out of their open punch", async () => {
  openEntry();
  db.signIn(EMPLOYEE);

  const res = await clock.POST(post({ action: "out", ...SHOP }), noParams);

  assert.equal(res.status, 200);
  const [punch] = db.rows("time_entries");
  assert.equal(punch.status, "closed");
  assert.ok(punch.clock_out_at, "clock_out_at was not set");
});

test("a clock-out that loses a race with a fob tap leaves the fob's clock-out alone", async () => {
  const entry = openEntry();
  db.signIn(EMPLOYEE);
  // The Pi closes the punch between the route's read and its write.
  db.beforeWrite = () => Object.assign(entry, { status: "closed", clock_out_at: "2026-09-28T13:55:00.000Z" });

  const res = await clock.POST(post({ action: "out", ...SHOP }), noParams);

  assert.equal(res.ok, false);
  assert.equal(db.rows("time_entries")[0].clock_out_at, "2026-09-28T13:55:00.000Z");
});

// ---- the clock-out nudge ----------------------------------------------------

test("an employee snoozes the clock-out nudge on their open punch by the configured interval", async () => {
  db.tables.app_settings.push({ id: 1, clockout_reminder_after_min: 45 });
  openEntry();
  db.signIn(EMPLOYEE);

  const before = Date.now();
  const res = await reminder.POST(post({ action: "snooze" }), { params: { id: "7" } });
  const after = Date.now();

  assert.equal(res.status, 200);
  const until = Date.parse(String(db.rows("time_entries")[0].clockout_reminder_snoozed_until));
  assert.ok(
    until >= before + 45 * 60000 && until <= after + 45 * 60000,
    `snoozed until ${new Date(until).toISOString()}`,
  );
});

test("an employee dismisses the clock-out nudge on their open punch", async () => {
  openEntry();
  db.signIn(EMPLOYEE);

  const res = await reminder.POST(post({ action: "dismiss" }), { params: { id: "7" } });

  assert.equal(res.status, 200);
  assert.ok(db.rows("time_entries")[0].clockout_reminder_dismissed_at, "dismissed_at was not set");
});

test("a snooze that loses a race with a clock-out does not touch the closed punch", async () => {
  const entry = openEntry();
  db.signIn(EMPLOYEE);
  db.beforeWrite = () => Object.assign(entry, { status: "closed", clock_out_at: "2026-09-28T13:55:00.000Z" });

  const res = await reminder.POST(post({ action: "snooze" }), { params: { id: "7" } });

  assert.equal(res.ok, false);
  assert.equal(db.rows("time_entries")[0].clockout_reminder_snoozed_until, null);
});

// ---- the Timesheets routes: managers only ---------------------------------

test("an employee cannot add a punch through the Timesheets route", async () => {
  db.signIn(EMPLOYEE);

  const res = await timesheet.POST(
    post({ employee_id: EMPLOYEE, clock_in_at: "2026-09-27T08:00:00Z", clock_out_at: "2026-09-27T20:00:00Z" }),
    noParams,
  );

  assert.equal(res.status, 403);
  assert.deepEqual(db.rows("time_entries"), []);
});

test("an employee cannot edit or delete a punch through the Timesheets route", async () => {
  openEntry();
  db.signIn(EMPLOYEE);

  const edit = await timesheetEntry.PATCH(
    new Request("http://time.test/api", {
      method: "PATCH",
      body: JSON.stringify({ clock_in_at: "2026-09-28T09:00:00Z" }),
    }),
    { params: { id: "7" } },
  );
  const del = await timesheetEntry.DELETE(
    new Request("http://time.test/api", { method: "DELETE" }),
    { params: { id: "7" } },
  );

  assert.equal(edit.status, 403);
  assert.equal(del.status, 403);
  assert.equal(db.rows("time_entries").length, 1);
  assert.equal(db.rows("time_entries")[0].clock_in_at, "2026-09-28T13:00:00.000Z");
});

test("a manager, even one off the roster, still adds a manual punch through the Timesheets route", async () => {
  db.signIn(MANAGER);

  const res = await timesheet.POST(
    post({ employee_id: EMPLOYEE, clock_in_at: "2026-09-27T08:00:00Z", clock_out_at: "2026-09-27T12:00:00Z" }),
    noParams,
  );

  assert.equal(res.status, 200);
  const [punch] = db.rows("time_entries");
  assert.equal(punch.employee_id, EMPLOYEE);
  assert.equal(punch.clock_in_at, "2026-09-27T08:00:00Z");
  assert.equal(punch.manual, true);
});
