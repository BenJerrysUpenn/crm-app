// The payroll page's "crew didn't punch" card, for an event with no Catering
// shift on the schedule (Alina, 2026-10-05): one save creates the event's
// Catering shift, shaped as the CRM's catering shift writer shapes it
// (root lib/cateringShifts.ts: position Catering, deal_id and deal_slot set,
// live), and the punch on it, so the person is the event's crew and its tip
// splits by punches. POST /api/payroll/event-punch.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request, ctx: { params: Record<string, string> }) => Promise<Response>;

const route = await loadAppModule<{ POST: Handler }>("app/api/payroll/event-punch/route.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const DEAL = { id: 25300, company: "Example Gala", venue_name: "Example Hall", venue_address: "1 Example St", stage: "Booked Paid", event_date: "2026-10-07" };

function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}
function post(body: unknown): Request {
  return new Request("http://time.test/api/payroll/event-punch", { method: "POST", body: JSON.stringify(body) });
}
const noParams = { params: {} };
const BODY = { deal_id: DEAL.id, employee_id: SAM, clock_in_at: edt("2026-10-07", "15:00"), clock_out_at: edt("2026-10-07", "18:00") };

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Test Manager" },
      { id: SAM, role: "employee", active: true, full_name: "Test Sam" },
    ],
    deals: [DEAL],
    shifts: [],
    time_entries: [],
  });
  db.signIn(MANAGER);
});

test("event punch: managers only", async () => {
  db.signIn(SAM);
  const res = await route.POST(post(BODY), noParams);
  assert.equal(res.status, 403);
  assert.equal(db.rows("shifts").length, 0);
  assert.equal(db.rows("time_entries").length, 0);
});

test("event punch: with no shift on the event, it creates the Catering shift and the punch on it", async () => {
  const res = await route.POST(post(BODY), noParams);
  assert.equal(res.status, 200, await res.clone().text());
  const [shift] = db.rows("shifts");
  assert.equal(shift.employee_id, SAM);
  assert.equal(shift.position, "Catering");
  assert.equal(shift.deal_id, DEAL.id);
  assert.equal(shift.deal_slot, 1);
  assert.equal(shift.published, true);
  assert.equal(shift.starts_at, BODY.clock_in_at);
  assert.equal(shift.ends_at, BODY.clock_out_at);
  assert.match(String(shift.notes), /deal #25300/);
  assert.match(String(shift.notes), /Example Hall/);
  const [entry] = db.rows("time_entries");
  assert.equal(entry.employee_id, SAM);
  assert.equal(entry.shift_id, shift.id);
  assert.equal(entry.manual, true);
  assert.equal(entry.status, "closed");
  assert.equal(entry.clock_in_at, BODY.clock_in_at);
  assert.equal(entry.clock_out_at, BODY.clock_out_at);
});

test("event punch: an unassigned Catering slot on the event is filled, not duplicated", async () => {
  db.tables.shifts.push({ id: 50, employee_id: null, position: "Catering", deal_id: DEAL.id, deal_slot: 1, published: true, starts_at: edt("2026-10-07", "14:00"), ends_at: edt("2026-10-07", "18:30") });
  const res = await route.POST(post(BODY), noParams);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(db.rows("shifts").length, 1);
  assert.equal(db.rows("shifts")[0].employee_id, SAM);
  assert.equal(db.rows("time_entries")[0].shift_id, 50);
});

test("event punch: with every Catering slot on the event taken, the new shift takes the next slot", async () => {
  const OTHER = "00000000-0000-0000-0000-00000000000c";
  const ANOTHER = "00000000-0000-0000-0000-00000000000d";
  db.tables.shifts.push(
    { id: 50, employee_id: OTHER, position: "Catering", deal_id: DEAL.id, deal_slot: 1, published: true, starts_at: edt("2026-10-07", "14:00"), ends_at: edt("2026-10-07", "18:30") },
    { id: 51, employee_id: ANOTHER, position: "Catering", deal_id: DEAL.id, deal_slot: 2, published: true, starts_at: edt("2026-10-07", "14:00"), ends_at: edt("2026-10-07", "18:30") },
  );
  const res = await route.POST(post(BODY), noParams);
  assert.equal(res.status, 200, await res.clone().text());
  const made = db.rows("shifts").filter((s) => s.employee_id === SAM);
  assert.equal(made.length, 1);
  assert.equal(made[0].deal_slot, 3);
  assert.equal(db.rows("shifts").find((s) => s.id === 50)!.employee_id, OTHER, "a taken slot is not reassigned");
  assert.equal(db.rows("time_entries")[0].shift_id, made[0].id);
});

test("event punch: an unassigned shift on the event that is not a Catering shift is left alone", async () => {
  db.tables.shifts.push({ id: 60, employee_id: null, position: "PENN Opener", deal_id: DEAL.id, deal_slot: null, published: true, starts_at: edt("2026-10-07", "14:00"), ends_at: edt("2026-10-07", "18:30") });
  const res = await route.POST(post(BODY), noParams);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(db.rows("shifts").find((s) => s.id === 60)!.employee_id, null);
  const made = db.rows("shifts").find((s) => s.employee_id === SAM)!;
  assert.equal(made.position, "Catering");
  assert.equal(made.deal_slot, 1);
});

test("event punch: a punch needs a clock-out after its clock-in", async () => {
  assert.equal((await route.POST(post({ ...BODY, clock_out_at: null }), noParams)).status, 400);
  assert.equal((await route.POST(post({ ...BODY, clock_out_at: BODY.clock_in_at }), noParams)).status, 400);
  assert.equal(db.rows("shifts").length, 0);
  assert.equal(db.rows("time_entries").length, 0);
});

test("event punch: a punch needs who it is for", async () => {
  assert.equal((await route.POST(post({ ...BODY, employee_id: "" }), noParams)).status, 400);
  assert.equal(db.rows("shifts").length, 0);
});

test("event punch: a deal_id that is not a deal's id is refused", async () => {
  for (const deal_id of [0, -1, 1.5, "abc", null]) {
    const res = await route.POST(post({ ...BODY, deal_id }), noParams);
    assert.equal(res.status, 400, `deal_id ${JSON.stringify(deal_id)}`);
  }
  assert.equal(db.rows("shifts").length, 0);
});

test("event punch: an unknown deal is refused", async () => {
  const res = await route.POST(post({ ...BODY, deal_id: 99999 }), noParams);
  assert.equal(res.status, 404);
  assert.equal(db.rows("shifts").length, 0);
});

test("event punch: a slot somebody fills between the read and the save is not taken over", async () => {
  const RIVAL = "00000000-0000-0000-0000-00000000000e";
  db.tables.shifts.push({ id: 50, employee_id: null, position: "Catering", deal_id: DEAL.id, deal_slot: 1, published: true, starts_at: edt("2026-10-07", "14:00"), ends_at: edt("2026-10-07", "18:30") });
  db.beforeWrite = (table) => {
    if (table === "shifts") db.tables.shifts[0].employee_id = RIVAL;
  };
  const res = await route.POST(post(BODY), noParams);
  assert.equal(res.status, 409);
  assert.equal(db.rows("shifts")[0].employee_id, RIVAL);
  assert.equal(db.rows("time_entries").length, 0);
});

test("event punch: when the shift cannot be made, nothing is written and the reason comes back", async () => {
  db.missingColumns.shifts = ["deal_slot"];
  const res = await route.POST(post(BODY), noParams);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /deal_slot/);
  assert.equal(db.rows("shifts").length, 0);
  assert.equal(db.rows("time_entries").length, 0);
});

test("event punch: when the punch cannot be written, the shift it made is taken back out", async () => {
  db.missingColumns.time_entries = ["shift_id"];
  const res = await route.POST(post(BODY), noParams);
  assert.equal(res.status, 400);
  assert.equal(db.rows("shifts").length, 0);
});

test("event punch: when the punch cannot be written, a filled slot is emptied again", async () => {
  db.tables.shifts.push({ id: 50, employee_id: null, position: "Catering", deal_id: DEAL.id, deal_slot: 1, published: true, starts_at: edt("2026-10-07", "14:00"), ends_at: edt("2026-10-07", "18:30") });
  db.missingColumns.time_entries = ["shift_id"];
  const res = await route.POST(post(BODY), noParams);
  assert.equal(res.status, 400);
  assert.equal(db.rows("shifts")[0].employee_id, null);
});
