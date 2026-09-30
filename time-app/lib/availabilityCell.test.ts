// Unit tests for the schedule grid's availability cell label.
//
//   npm test        (node --test lib/*.test.ts)
//
// 2026-09-29 is a Tuesday (weekday 2); 2026-09-28 the Monday before.

import { test } from "node:test";
import assert from "node:assert/strict";

import { availabilityCell, shortClock, shortSpan } from "./availabilityCell.ts";
import { resolveDay, type AvailabilityRow } from "./availabilityCheck.ts";

const SAM = "sam";
const TUE = "2026-09-29";
const MON = "2026-09-28";

function dated(date: string, start: string | null, end: string | null, preference: AvailabilityRow["preference"] = "available"): AvailabilityRow {
  return { employee_id: SAM, weekday: null, specific_date: date, start_time: start && start + ":00", end_time: end && end + ":00", is_available: true, status: "approved", preference };
}
function weekly(weekday: number, start: string | null, end: string | null, preference: AvailabilityRow["preference"] = "available", is_available = true): AvailabilityRow {
  return { employee_id: SAM, weekday, specific_date: null, start_time: start && start + ":00", end_time: end && end + ":00", is_available, status: "approved", preference };
}
function timeOff(date: string, status: "approved" | "pending" | "denied"): AvailabilityRow {
  return { employee_id: SAM, weekday: null, specific_date: date, start_time: null, end_time: null, is_available: false, status, preference: "available" };
}
const cell = (rows: AvailabilityRow[], date = TUE) => availabilityCell(resolveDay(SAM, date, rows));

// --- short times ------------------------------------------------------------

test("shortClock: whole hours drop the minutes, a/p suffix, midnight and noon", () => {
  assert.equal(shortClock(0), "12a");
  assert.equal(shortClock(360), "6a");
  assert.equal(shortClock(720), "12p");
  assert.equal(shortClock(1110), "6:30p");
  assert.equal(shortClock(1440), "12a");
});

test("shortSpan: shared half drops the first suffix, mixed halves keep both, whole day is 'all day'", () => {
  assert.equal(shortSpan(1080, 1200), "6–8p");
  assert.equal(shortSpan(720, 1020), "12–5p");
  assert.equal(shortSpan(540, 1020), "9a–5p");
  assert.equal(shortSpan(690, 840), "11:30a–2p");
  assert.equal(shortSpan(1080, 1440), "6p–12a");
  assert.equal(shortSpan(0, 1440), "all day");
});

// --- full day ---------------------------------------------------------------

test("approved time off: Time off, whatever else is on file", () => {
  const c = cell([timeOff(TUE, "approved"), dated(TUE, "09:00", "17:00")]);
  assert.equal(c.state, "time_off");
  assert.equal("label" in c && c.label, "Time off");
  assert.equal(c.title, "Time off (approved)");
});

test("pending time off: its own state and label", () => {
  const c = cell([timeOff(TUE, "pending"), weekly(2, "12:00", "17:00", "preferred")]);
  assert.equal(c.state, "time_off_pending");
  assert.equal("label" in c && c.label, "Time off pending");
  assert.equal(c.title, "Time-off request pending");
});

test("denied time off is ignored: the hours show instead", () => {
  const c = cell([timeOff(TUE, "denied"), dated(TUE, "12:00", "17:00")]);
  assert.deepEqual(c.state === "hours" && c.lines, [{ kind: "available", text: "Avail 12–5p" }]);
});

test("can't work all day (a dated all-day block): Unavailable", () => {
  const c = cell([dated(TUE, null, null, "unavailable")]);
  assert.equal(c.state, "unavailable");
  assert.equal("label" in c && c.label, "Unavailable");
  assert.equal(c.title, "Can't work all day");
});

test("can't work all day from the weekly pattern (is_available false): Unavailable", () => {
  assert.equal(cell([weekly(2, null, null, "available", false)]).state, "unavailable");
});

// Weekly and dated rows stay separate blocks in the resolved day, so these two
// only cover the day once the cell joins them.
test("can't-work blocks that together cover the day count as the whole day", () => {
  assert.equal(cell([weekly(2, "00:00", "12:00", "unavailable"), dated(TUE, "12:00", null, "unavailable")]).state, "unavailable");
});

// --- partial day ------------------------------------------------------------

test("partial day: can't-work line first, then prefers", () => {
  const c = cell([weekly(2, "12:00", "17:00", "preferred"), dated(TUE, "18:00", "20:00", "unavailable")]);
  assert.equal(c.state, "hours");
  assert.deepEqual(c.state === "hours" && c.lines, [
    { kind: "unavailable", text: "Can't 6–8p" },
    { kind: "preferred", text: "Prefers 12–5p" },
  ]);
  assert.equal(c.title, "Prefers 12:00 PM to 5:00 PM; can't work 6:00 PM to 8:00 PM");
});

test("a dated can-work entry cuts a hole in a weekly all-day can't: both show, as hours", () => {
  const c = cell([weekly(2, null, null, "unavailable"), dated(TUE, "12:00", "17:00")]);
  assert.deepEqual(c.state === "hours" && c.lines, [
    { kind: "unavailable", text: "Can't 12a–12p, 5p–12a" },
    { kind: "available", text: "Avail 12–5p" },
  ]);
});

test("available all day: one line, not a shaded cell", () => {
  const c = cell([weekly(2, null, null)]);
  assert.deepEqual(c.state === "hours" && c.lines, [{ kind: "available", text: "Avail all day" }]);
});

test("several spans of one kind join on one line", () => {
  const c = cell([dated(TUE, "09:00", "12:00"), dated(TUE, "17:00", "22:00")]);
  assert.deepEqual(c.state === "hours" && c.lines, [{ kind: "available", text: "Avail 9a–12p, 5–10p" }]);
});

test("touching spans of one kind from the weekly pattern and a date read as one span", () => {
  const c = cell([weekly(2, "09:00", "12:00"), dated(TUE, "12:00", "17:00")]);
  assert.deepEqual(c.state === "hours" && c.lines, [{ kind: "available", text: "Avail 9a–5p" }]);
});

test("an overnight block from the day before shows on this day up to its end", () => {
  const c = cell([dated(MON, "18:00", "02:00")]);
  assert.deepEqual(c.state === "hours" && c.lines, [{ kind: "available", text: "Avail 12–2a" }]);
});

// --- nothing on file --------------------------------------------------------

test("nothing on file: the faint 'no avail.' marker, never Unavailable", () => {
  const c = cell([]);
  assert.equal(c.state, "none");
  assert.equal("label" in c && c.label, "no avail.");
  assert.equal(c.title, "No availability on file");
});

test("someone else's rows don't count for this person", () => {
  const other: AvailabilityRow = { ...dated(TUE, null, null, "unavailable"), employee_id: "alex" };
  assert.equal(cell([other]).state, "none");
});
