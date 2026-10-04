// There are no draft shifts. Managers filled in the week, saw it on their own
// screen and took it as live, while staff saw nothing until somebody pressed
// "Publish week". Every route that writes a shift now writes it live, and the
// people on those shifts get the "New shift posted" message publishing used
// to send.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;

const shifts = await loadAppModule<{ POST: Handler }>("app/api/shifts/route.ts");
const shiftById = await loadAppModule<{ PATCH: Handler }>("app/api/shifts/[id]/route.ts");
const copyWeek = await loadAppModule<{ POST: Handler }>("app/api/shifts/copy-week/route.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const JO = "00000000-0000-0000-0000-00000000000c";
const WEEK = "2026-10-04"; // Sunday
const LAST_TUE = "2026-09-29";

function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}
function req(method: string, body: unknown): Request {
  return new Request("http://time.test/api", { method, body: JSON.stringify(body) });
}
const noParams = { params: { id: "" } };

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: false, full_name: "Test Owner" },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee" },
      { id: JO, role: "employee", active: true, full_name: "Jo Park" },
    ],
    shifts: [],
    availability: [],
    notifications: [],
  });
  db.signIn(MANAGER);
});

const notified = () => db.rows("notifications").map((n) => [n.user_id, n.type]);

test("the publish-week route is gone", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  assert.equal(existsSync(join(here, "..", "app", "api", "shifts", "publish-week")), false);
});

test("a new shift is live even when an old page asks for a draft, and its person is told", async () => {
  const res = await shifts.POST(
    req("POST", { employee_id: SAM, starts_at: edt("2026-10-06", "12:00"), ends_at: edt("2026-10-06", "17:00"), published: false, confirmAvailability: true }),
    noParams,
  );
  assert.equal(res.status, 200);
  assert.equal(db.rows("shifts")[0].published, true);
  assert.deepEqual(notified(), [[SAM, "shift_published"]]);
});

test("a new open shift is live and nobody is messaged", async () => {
  const res = await shifts.POST(req("POST", { employee_id: null, starts_at: edt("2026-10-06", "12:00"), ends_at: edt("2026-10-06", "17:00") }), noParams);
  assert.equal(res.status, 200);
  assert.equal(db.rows("shifts")[0].published, true);
  assert.deepEqual(notified(), []);
});

test("an edit can never put a shift back into draft", async () => {
  db.tables.shifts.push({ id: 1, employee_id: SAM, starts_at: edt("2026-10-06", "12:00"), ends_at: edt("2026-10-06", "17:00"), position: null, published: true });
  const res = await shiftById.PATCH(req("PATCH", { notes: "bring keys", published: false }), { params: { id: "1" } });
  assert.equal(res.status, 200);
  assert.equal(db.rows("shifts")[0].published, true);
  // An edit of an assigned shift is a change, not a new shift.
  assert.deepEqual(notified(), [[SAM, "schedule_change"]]);
});

test("editing a leftover draft puts it live and tells its person it is new", async () => {
  db.tables.shifts.push({ id: 1, employee_id: SAM, starts_at: edt("2026-10-06", "12:00"), ends_at: edt("2026-10-06", "17:00"), position: null, published: false });
  const res = await shiftById.PATCH(req("PATCH", { notes: "bring keys" }), { params: { id: "1" } });
  assert.equal(res.status, 200);
  assert.equal(db.rows("shifts")[0].published, true);
  assert.deepEqual(notified(), [[SAM, "shift_published"]]);
});

test("assigning an open shift to someone tells them it is a new shift", async () => {
  db.tables.shifts.push({ id: 1, employee_id: null, starts_at: edt("2026-10-06", "12:00"), ends_at: edt("2026-10-06", "17:00"), position: null, published: true });
  const res = await shiftById.PATCH(req("PATCH", { employee_id: JO, confirmAvailability: true }), { params: { id: "1" } });
  assert.equal(res.status, 200);
  assert.deepEqual(notified(), [[JO, "shift_published"]]);
});

test("copy last week writes live shifts and tells each person once per shift", async () => {
  db.tables.shifts.push(
    { id: 1, employee_id: SAM, location_id: null, starts_at: edt(LAST_TUE, "12:00"), ends_at: edt(LAST_TUE, "17:00"), position: "PENN Opener", notes: null, published: true },
    { id: 2, employee_id: null, location_id: null, starts_at: edt(LAST_TUE, "17:00"), ends_at: edt(LAST_TUE, "22:00"), position: "PENN Closer", notes: null, published: true },
  );
  const res = await copyWeek.POST(req("POST", { weekStart: WEEK }), noParams);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, copied: 2 });

  const copies = db.rows("shifts").slice(2);
  assert.equal(copies.length, 2);
  assert.ok(copies.every((s) => s.published === true));
  assert.equal(copies[0].starts_at, edt("2026-10-06", "12:00"));
  // The open copy has nobody to tell.
  assert.deepEqual(notified(), [[SAM, "shift_published"]]);
});
