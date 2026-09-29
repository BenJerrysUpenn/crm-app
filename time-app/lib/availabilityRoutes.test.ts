// The availability check, driven through the real route handlers.
//
// lib/availabilityCheck.test.ts proves the rules. These prove the routes ask
// them: that saving a shift for someone who can't work it stops for a yes,
// that publish-week lists every mismatch in its one 409 and force overrides
// it, that auto-fill picks by the same rules, and that weekly ("repeats every
// …") rows are read at all — the bug that made everyone on a weekly pattern
// look like they had nothing on file.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";
import { loadAvailabilityRows } from "./availabilityRows.ts";

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;

const shifts = await loadAppModule<{ POST: Handler }>("app/api/shifts/route.ts");
const shiftById = await loadAppModule<{ PATCH: Handler }>("app/api/shifts/[id]/route.ts");
const publishWeek = await loadAppModule<{ POST: Handler }>("app/api/shifts/publish-week/route.ts");
const autoFill = await loadAppModule<{ POST: Handler }>("app/api/schedule/auto-fill/route.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const JO = "00000000-0000-0000-0000-00000000000c";
const WEEK = "2026-09-27"; // Sunday
const TUE = "2026-09-29";

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
    shift_types: [],
    store_hours: [],
    store_hours_exceptions: [],
    annotations: [],
    notifications: [],
  });
  db.signIn(MANAGER);
});

function weekly(employee_id: string, weekday: number, start: string, end: string, preference = "preferred") {
  return { employee_id, weekday, specific_date: null, start_time: start, end_time: end, is_available: true, status: "approved", preference };
}

// ---- save ---------------------------------------------------------------------

test("saving a shift for someone with nothing on file stops with no_availability, and saves on confirm", async () => {
  const body = { employee_id: SAM, starts_at: edt(TUE, "12:00"), ends_at: edt(TUE, "17:00"), position: "Catering" };

  const refused = await shifts.POST(req("POST", body), noParams);
  assert.equal(refused.status, 409);
  const j = await refused.json();
  assert.equal(j.error, "availability_mismatch");
  assert.deepEqual(j.mismatch.reasons, [{ kind: "no_availability", date: TUE }]);
  assert.equal(db.rows("shifts").length, 0);

  const saved = await shifts.POST(req("POST", { ...body, confirmAvailability: true }), noParams);
  assert.equal(saved.status, 200);
  assert.equal(db.rows("shifts").length, 1);
});

test("weekly availability is read: a shift inside someone's weekly hours saves without asking", async () => {
  db.tables.availability.push(weekly(SAM, 2, "11:00:00", "22:00:00"));
  const res = await shifts.POST(
    req("POST", { employee_id: SAM, starts_at: edt(TUE, "12:00"), ends_at: edt(TUE, "20:00") }),
    noParams,
  );
  assert.equal(res.status, 200);
});

test("open shifts are saved without an availability check", async () => {
  const res = await shifts.POST(req("POST", { employee_id: null, starts_at: edt(TUE, "12:00"), ends_at: edt(TUE, "17:00") }), noParams);
  assert.equal(res.status, 200);
});

test("editing only the notes of a shift does not re-ask; moving it to someone off that day does", async () => {
  db.tables.availability.push({ employee_id: JO, weekday: null, specific_date: TUE, start_time: null, end_time: null, is_available: false, status: "approved", preference: "available" });
  db.tables.shifts.push({ id: 5, employee_id: SAM, starts_at: edt(TUE, "12:00"), ends_at: edt(TUE, "17:00"), position: null, published: false });

  const notes = await shiftById.PATCH(req("PATCH", { employee_id: SAM, starts_at: edt(TUE, "12:00"), ends_at: edt(TUE, "17:00"), notes: "bring keys" }), { params: { id: "5" } });
  assert.equal(notes.status, 200);

  const moved = await shiftById.PATCH(req("PATCH", { employee_id: JO }), { params: { id: "5" } });
  assert.equal(moved.status, 409);
  const j = await moved.json();
  assert.deepEqual(j.mismatch.reasons, [{ kind: "time_off", date: TUE, status: "approved" }]);
  assert.equal(db.rows("shifts")[0].employee_id, SAM);
});

// ---- publish ------------------------------------------------------------------

test("publish-week lists every availability mismatch in the one 409, and force publishes", async () => {
  db.tables.availability.push(weekly(SAM, 2, "12:00:00", "17:00:00"));
  db.tables.shifts.push(
    { id: 1, employee_id: SAM, starts_at: edt(TUE, "12:00"), ends_at: edt(TUE, "22:00"), position: "PENN Closer", published: false },
    { id: 2, employee_id: JO, starts_at: edt(TUE, "12:00"), ends_at: edt(TUE, "17:00"), position: "Catering", published: false },
    { id: 3, employee_id: null, starts_at: edt(TUE, "12:00"), ends_at: edt(TUE, "17:00"), position: null, published: false },
  );

  const refused = await publishWeek.POST(req("POST", { weekStart: WEEK }), noParams);
  assert.equal(refused.status, 409);
  const j = await refused.json();
  assert.equal(j.error, "schedule_checks");
  assert.deepEqual(
    j.availability.map((m: { shift_id: number; employee_name: string; reasons: { kind: string }[] }) => [m.shift_id, m.employee_name, m.reasons.map((r) => r.kind)]),
    [
      [1, "Sam Lee", ["outside_available_hours"]],
      [2, "Jo Park", ["no_availability"]],
    ],
  );
  assert.ok(db.rows("shifts").every((s) => s.published === false));

  // Publishing notifies each person; without a service key the email lookup
  // is skipped instead of reaching for an auth admin endpoint the fake lacks.
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const forced = await publishWeek.POST(req("POST", { weekStart: WEEK, force: true }), noParams);
  assert.equal(forced.status, 200);
  assert.ok(db.rows("shifts").every((s) => s.published === true));
});

// ---- auto-fill ------------------------------------------------------------------

test("auto-fill assigns by the shared rules: weekly hours count, pending time off does not", async () => {
  db.tables.availability.push(
    weekly(SAM, 2, "11:00:00", "22:00:00"),
    weekly(JO, 2, "11:00:00", "22:00:00", "available"),
    { employee_id: SAM, weekday: null, specific_date: TUE, start_time: null, end_time: null, is_available: false, status: "pending", preference: "available" },
  );
  db.tables.shifts.push({ id: 9, employee_id: null, starts_at: edt(TUE, "12:00"), ends_at: edt(TUE, "17:00"), published: false });

  const res = await autoFill.POST(req("POST", { weekStart: WEEK }), noParams);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, assigned: 1, left: 0 });
  assert.equal(db.rows("shifts")[0].employee_id, JO);
});

// ---- loader ---------------------------------------------------------------------

test("loadAvailabilityRows reports a failed read as a failure, never as 'nothing on file'", async () => {
  const failing = {
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "not", "gte", "lte", "in"]) q[m] = () => q;
      q.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: "timeout" } });
      return q;
    },
  };
  assert.deepEqual(await loadAvailabilityRows(failing, { from: "2026-09-26", to: "2026-10-04" }), { ok: false });
});
