// Weekly availability repeats until a date (bj-finance #754, migration 48).
// The owner's words: "availability needs repeat until rather than repeat
// forever."
//
// The stories:
//   * Saving a weekly block needs a repeat-until date; the editor starts it
//     three months from today. A date in the past, or none, is refused.
//   * A weekly row speaks for dates up to and including its repeat-until date
//     and for none after, in every reader: the save check and auto-fill, the
//     schedule grid cell, the team grid, the person's own calendar.
//   * A row saved before migration 48 has no repeat-until date and stays
//     open-ended.
//   * Before migration 48 is applied, a weekly save is refused with a message,
//     never saved without its end date, and nothing already saved is lost.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts. Time: node:test's mock Date.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";
import {
  addMonths,
  defaultRepeatUntil,
  parseRepeatUntil,
  REPEAT_UNTIL_NOT_READY,
  REPEAT_UNTIL_PAST,
  REPEAT_UNTIL_REQUIRED,
  weeklyRowApplies,
} from "./repeatUntil.ts";
import { resolveDay, type AvailabilityRow } from "./availabilityCheck.ts";
import { availabilityCell } from "./availabilityCell.ts";
import { buildTeamGrid } from "./teamAvailability.ts";

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;

const availability = await loadAppModule<{ POST: Handler }>("app/api/availability/route.ts");
const recurring = await loadAppModule<{ PUT: Handler }>("app/api/availability/recurring/route.ts");
const shifts = await loadAppModule<{ POST: Handler }>("app/api/shifts/route.ts");
const autoFill = await loadAppModule<{ POST: Handler }>("app/api/schedule/auto-fill/route.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const JO = "00000000-0000-0000-0000-00000000000c";

// Tuesdays: 2026-10-13 (the last date of the row below), 2026-10-20 (after it).
const LAST_TUE = "2026-10-13";
const NEXT_TUE = "2026-10-20";

function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}
function req(method: string, body: unknown): Request {
  return new Request("http://time.test/api", { method, body: JSON.stringify(body) });
}
const noParams = { params: { id: "" } };

function weeklyRow(employee_id: string, weekday: number, extra: Partial<AvailabilityRow> = {}): AvailabilityRow {
  return {
    employee_id,
    weekday,
    specific_date: null,
    start_time: "11:00:00",
    end_time: "22:00:00",
    is_available: true,
    status: "approved",
    preference: "preferred",
    created_at: "2026-09-01T12:00:00Z",
    repeat_until: LAST_TUE,
    ...extra,
  };
}

// ---- the date itself ------------------------------------------------------------

test("the editor starts the repeat-until date three months from today, on a day the month has", () => {
  assert.equal(defaultRepeatUntil("2026-10-08"), "2027-01-08");
  assert.equal(addMonths("2026-11-30", 3), "2027-02-28");
  assert.equal(addMonths("2027-11-30", 3), "2028-02-29");
});

test("a repeat-until date is required, a real date, and not in the past", () => {
  assert.deepEqual(parseRepeatUntil("2027-01-08", "2026-10-08"), { ok: true, value: "2027-01-08" });
  assert.deepEqual(parseRepeatUntil("2026-10-08", "2026-10-08"), { ok: true, value: "2026-10-08" });
  assert.deepEqual(parseRepeatUntil(undefined, "2026-10-08"), { ok: false, error: REPEAT_UNTIL_REQUIRED });
  assert.deepEqual(parseRepeatUntil("", "2026-10-08"), { ok: false, error: REPEAT_UNTIL_REQUIRED });
  assert.deepEqual(parseRepeatUntil("2027-02-30", "2026-10-08"), { ok: false, error: REPEAT_UNTIL_REQUIRED });
  assert.deepEqual(parseRepeatUntil("2026-10-07", "2026-10-08"), { ok: false, error: REPEAT_UNTIL_PAST });
});

// ---- every reader stops after it -----------------------------------------------------

test("a weekly row speaks for its last date and not the week after", () => {
  const rows = [weeklyRow(SAM, 2)];
  assert.deepEqual(resolveDay(SAM, LAST_TUE, rows).blocks.map((b) => b.kind), ["preferred"]);
  assert.deepEqual(resolveDay(SAM, NEXT_TUE, rows).blocks, []);
});

test("a block crossing midnight from its last date still counts that morning", () => {
  const rows = [weeklyRow(SAM, 2, { start_time: "20:00:00", end_time: "02:00:00", preference: "unavailable" })];
  // Wednesday after the last Tuesday: 00:00-02:00 still comes from Tuesday's block.
  assert.deepEqual(resolveDay(SAM, "2026-10-14", rows).blocks.map((b) => [b.from, b.to, b.kind]), [[0, 120, "unavailable"]]);
  assert.deepEqual(resolveDay(SAM, "2026-10-21", rows).blocks, []);
});

test("a row with no repeat-until date (saved before migration 48) stays open-ended", () => {
  const rows = [weeklyRow(SAM, 2, { repeat_until: null })];
  assert.deepEqual(resolveDay(SAM, "2027-06-01", rows).blocks.map((b) => b.kind), ["preferred"]);
  const absent = weeklyRow(SAM, 2);
  delete absent.repeat_until;
  assert.deepEqual(resolveDay(SAM, "2027-06-01", [absent]).blocks.map((b) => b.kind), ["preferred"]);
});

test("the schedule grid cell and the team grid stop showing it after the date", () => {
  const rows = [weeklyRow(SAM, 2)];
  assert.equal(availabilityCell(resolveDay(SAM, LAST_TUE, rows)).state, "hours");
  assert.equal(availabilityCell(resolveDay(SAM, NEXT_TUE, rows)).state, "none");

  const roster = [{ id: SAM, full_name: "Sam Lee" }];
  const tueOf = (weekStart: string) => buildTeamGrid(roster, weekStart, rows).rows[0].cells[2];
  assert.equal(tueOf("2026-10-11").state, "blocks");
  assert.equal(tueOf("2026-10-18").state, "none");
});

test("the person's own calendar shows the chip up to the date and not after", () => {
  const row = { weekday: 2, repeat_until: LAST_TUE };
  assert.equal(weeklyRowApplies(row, LAST_TUE, 2), true);
  assert.equal(weeklyRowApplies(row, NEXT_TUE, 2), false);
  assert.equal(weeklyRowApplies({ weekday: 2, repeat_until: null }, "2027-06-01", 2), true);
  assert.equal(weeklyRowApplies(row, "2026-10-12", 1), false);
});

// ---- through the routes ----------------------------------------------------------

let db: FakeSupabase;

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse(edt("2026-10-08", "10:00")) });
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: false, full_name: "Test Owner" },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee" },
      { id: JO, role: "employee", active: true, full_name: "Jo Park" },
    ],
    shifts: [],
    availability: [],
    annotations: [],
    notifications: [],
    shift_notices: [],
    availability_notices: [],
    shift_types: [],
    store_hours: [],
    store_hours_exceptions: [],
  });
});

afterEach(() => mock.timers.reset());

test("saving a weekly block without a repeat-until date is refused; with one, it is saved on the row", async () => {
  db.signIn(SAM);
  const body = { weekday: 2, is_available: true, preference: "preferred", start_time: "11:00:00", end_time: "22:00:00", status: "approved" };

  const refused = await availability.POST(req("POST", body), noParams);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, REPEAT_UNTIL_REQUIRED);
  const past = await availability.POST(req("POST", { ...body, repeat_until: "2026-10-07" }), noParams);
  assert.equal(past.status, 400);
  assert.equal(db.rows("availability").length, 0);

  const saved = await availability.POST(req("POST", { ...body, repeat_until: "2027-01-08" }), noParams);
  assert.equal(saved.status, 200);
  assert.deepEqual(db.rows("availability").map((r) => [r.weekday, r.repeat_until]), [[2, "2027-01-08"]]);
});

test("a dated block needs no repeat-until date and is saved without one", async () => {
  db.signIn(SAM);
  const res = await availability.POST(
    req("POST", { specific_date: "2026-10-13", is_available: true, preference: "preferred", repeat_until: "2027-01-08", status: "approved" }),
    noParams,
  );
  assert.equal(res.status, 200);
  assert.equal("repeat_until" in db.rows("availability")[0], false);
});

test("weekly blocks saved together need one repeat-until date, and every block carries it", async () => {
  db.signIn(SAM);
  const blocks = [
    { weekday: 1, start_time: "12:00:00", end_time: "17:00:00" },
    { weekday: 3, start_time: "12:00:00", end_time: "17:00:00" },
  ];
  assert.equal((await recurring.PUT(req("PUT", { blocks }), noParams)).status, 400);
  assert.equal((await recurring.PUT(req("PUT", { blocks, repeat_until: "2027-01-08" }), noParams)).status, 200);
  assert.deepEqual(db.rows("availability").map((r) => r.repeat_until), ["2027-01-08", "2027-01-08"]);
  // Clearing every block needs no date.
  assert.equal((await recurring.PUT(req("PUT", { blocks: [] }), noParams)).status, 200);
  assert.deepEqual(db.rows("availability"), []);
});

test("before migration 48, a weekly save is refused with a message and nothing already saved is lost", async () => {
  db.missingColumns = { availability: ["repeat_until"] };
  db.tables.availability.push({ id: 1, employee_id: SAM, weekday: 1, specific_date: null, start_time: "12:00:00", end_time: "17:00:00", is_available: true, status: "approved", preference: "available" });
  db.signIn(SAM);

  const one = await availability.POST(
    req("POST", { weekday: 2, is_available: true, preference: "preferred", status: "approved", repeat_until: "2027-01-08" }),
    noParams,
  );
  assert.equal(one.status, 503);
  assert.equal((await one.json()).error, REPEAT_UNTIL_NOT_READY);

  const all = await recurring.PUT(req("PUT", { repeat_until: "2027-01-08", blocks: [{ weekday: 3, start_time: "12:00:00", end_time: "17:00:00" }] }), noParams);
  assert.equal(all.status, 503);
  assert.deepEqual(db.rows("availability").map((r) => r.weekday), [1]);

  // A dated block is unaffected.
  const dated = await availability.POST(req("POST", { specific_date: "2026-10-13", is_available: true, preference: "preferred", status: "approved" }), noParams);
  assert.equal(dated.status, 200);
});

test("before migration 48, a first set of weekly blocks (none saved yet) is refused with the same message", async () => {
  db.missingColumns = { availability: ["repeat_until"] };
  db.signIn(SAM);
  const res = await recurring.PUT(req("PUT", { repeat_until: "2027-01-08", blocks: [{ weekday: 3, start_time: "12:00:00", end_time: "17:00:00" }] }), noParams);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, REPEAT_UNTIL_NOT_READY);
  assert.deepEqual(db.rows("availability"), []);
});

test("saving a shift after someone's weekly block has ended asks first; before it ended it does not", async () => {
  db.tables.availability.push(weeklyRow(SAM, 2));
  db.signIn(MANAGER);
  const on = (date: string) => ({ employee_id: SAM, starts_at: edt(date, "12:00"), ends_at: edt(date, "17:00") });

  assert.equal((await shifts.POST(req("POST", on(LAST_TUE)), noParams)).status, 200);
  const after = await shifts.POST(req("POST", on(NEXT_TUE)), noParams);
  assert.equal(after.status, 409);
  assert.deepEqual((await after.json()).mismatch.reasons, [{ kind: "no_availability", date: NEXT_TUE }]);
});

test("auto-fill does not pick someone whose weekly block has ended", async () => {
  db.tables.availability.push(weeklyRow(SAM, 2), weeklyRow(JO, 2, { repeat_until: null, preference: "available" }));
  db.tables.shifts.push({ id: 9, employee_id: null, starts_at: edt(NEXT_TUE, "12:00"), ends_at: edt(NEXT_TUE, "17:00"), published: true });
  db.signIn(MANAGER);

  const res = await autoFill.POST(req("POST", { weekStart: "2026-10-18" }), noParams);
  assert.equal(res.status, 200);
  assert.equal(db.rows("shifts")[0].employee_id, JO);
});
