// The availability check, driven through the real route handlers.
//
// lib/availabilityCheck.test.ts proves the rules. These prove the routes ask
// them: that saving a shift for someone who can't work it stops for a yes,
// that auto-fill picks by the same rules, and that weekly ("repeats every
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
  // The shift is live, so the person it went to is told, as publishing used to:
  // on the bell now, and queued for the 8pm summary (lib/shiftNotice.ts).
  assert.deepEqual(
    db.rows("notifications").map((n) => [n.user_id, n.type]),
    [[JO, "shift_published"]],
  );
  assert.deepEqual(
    db.rows("shift_notices").map((n) => [n.shift_id, n.employee_id, n.notice]),
    [[9, JO, "posted"]],
  );
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

test("loadAvailabilityRows reads created_at, so weekly rows start on the day they were made", async () => {
  const selects: string[] = [];
  const recording = {
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = (cols: string) => {
        selects.push(cols);
        return q;
      };
      for (const m of ["not", "gte", "lte", "in"]) q[m] = () => q;
      q.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return q;
    },
  };
  await loadAvailabilityRows(recording, { from: "2026-09-26", to: "2026-10-04" });
  assert.equal(selects.length, 2);
  for (const cols of selects) assert.match(cols, /\bcreated_at\b/);
});

test("saving a shift on a date before a weekly can't-work row was created is not a conflict", async () => {
  const SUN = "2026-09-27";
  const NEXT_SUN = "2026-10-04";
  db.tables.availability.push(
    // Their older weekly pattern: Sundays, any time.
    { ...weekly(SAM, 0, "00:00", "00:00", "available"), start_time: null, end_time: null },
    // Added Monday 09-28: can't work Sundays.
    { ...weekly(SAM, 0, "00:00", "00:00", "unavailable"), start_time: null, end_time: null, created_at: "2026-09-28T18:30:00Z" },
  );
  const before = await shifts.POST(req("POST", { employee_id: SAM, starts_at: edt(SUN, "12:00"), ends_at: edt(SUN, "17:00") }), noParams);
  assert.equal(before.status, 200);

  const after = await shifts.POST(req("POST", { employee_id: SAM, starts_at: edt(NEXT_SUN, "12:00"), ends_at: edt(NEXT_SUN, "17:00") }), noParams);
  assert.equal(after.status, 409);
  const j = await after.json();
  assert.deepEqual(j.mismatch.reasons, [{ kind: "unavailable_overlap", date: NEXT_SUN, from: "12:00", to: "17:00" }]);
});
