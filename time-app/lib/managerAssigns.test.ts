// Catering shifts (the ones the CRM writes for a booked deal, carrying
// deal_id) are assigned by a manager. Staff see them but cannot claim or
// request them. Alina, 2026-10-03: "they should wait to be assigned by a
// manager." The database side is supabase/migration_34_verify.sql.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";
import { MANAGER_ASSIGNS_ERROR, managerAssignsOnly } from "./managerAssigns.ts";

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;

const claim = await loadAppModule<{ POST: Handler }>("app/api/shifts/[id]/claim/route.ts");
const requestPickup = await loadAppModule<{ POST: Handler }>("app/api/shifts/[id]/request-pickup/route.ts");
const shiftById = await loadAppModule<{ PATCH: Handler }>("app/api/shifts/[id]/route.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";

function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}
function req(method: string, body: unknown): Request {
  return new Request("http://time.test/api", { method, body: JSON.stringify(body) });
}
const id = (n: number) => ({ params: { id: String(n) } });

// Shift 1: a catering crew slot the CRM wrote. Shift 2: an ordinary open shift.
const CATERING = { id: 1, employee_id: null, starts_at: edt("2026-10-23", "17:45"), ends_at: edt("2026-10-23", "21:45"), position: "Catering", notes: null, published: true, deal_id: 15102, deal_slot: 1 };
const PLAIN = { id: 2, employee_id: null, starts_at: edt("2026-10-24", "12:00"), ends_at: edt("2026-10-24", "17:00"), position: "PENN Opener", notes: null, published: true, deal_id: null };

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Test Owner", phone: null },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee", phone: null },
    ],
    shifts: [{ ...CATERING }, { ...PLAIN }],
    shift_requests: [],
    availability: [],
    notifications: [],
  });
});

const shift = (n: number) => db.rows("shifts").find((s) => s.id === n)!;
const notified = () => db.rows("notifications").map((n) => [n.user_id, n.type]);

test("a shift with a deal_id is manager-assign-only; one without is not", () => {
  assert.equal(managerAssignsOnly({ deal_id: 15102 }), true);
  assert.equal(managerAssignsOnly({ deal_id: null }), false);
  assert.equal(managerAssignsOnly({}), false);
});

test("staff cannot claim a catering shift: 403, it stays open, nobody is messaged", async () => {
  db.signIn(SAM);
  const res = await claim.POST(req("POST", {}), id(1));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: MANAGER_ASSIGNS_ERROR });
  assert.equal(shift(1).employee_id, null);
  assert.deepEqual(notified(), []);
});

test("staff cannot request a catering shift either: 403 and no request is filed", async () => {
  db.signIn(SAM);
  const res = await requestPickup.POST(req("POST", {}), id(1));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: MANAGER_ASSIGNS_ERROR });
  assert.deepEqual(db.rows("shift_requests"), []);
  assert.deepEqual(notified(), []);
});

test("an ordinary open shift can still be requested and claimed", async () => {
  db.signIn(SAM);
  const asked = await requestPickup.POST(req("POST", {}), id(2));
  assert.equal(asked.status, 200);
  assert.equal(db.rows("shift_requests").length, 1);

  const taken = await claim.POST(req("POST", {}), id(2));
  assert.equal(taken.status, 200);
  assert.equal(shift(2).employee_id, SAM);
});

test("a manager assigns a catering shift and the person gets New shift posted", async () => {
  db.signIn(MANAGER);
  const res = await shiftById.PATCH(req("PATCH", { employee_id: SAM, confirmAvailability: true }), id(1));
  assert.equal(res.status, 200);
  assert.equal(shift(1).employee_id, SAM);
  assert.equal(shift(1).published, true);
  assert.deepEqual(notified(), [[SAM, "shift_published"]]);
  const posted = db.rows("notifications")[0];
  assert.equal(posted.title, "New shift posted");
});

test("a manager can still use the claim route on a catering shift", async () => {
  db.signIn(MANAGER);
  const res = await claim.POST(req("POST", {}), id(1));
  assert.equal(res.status, 200);
  assert.equal(shift(1).employee_id, MANAGER);
});
