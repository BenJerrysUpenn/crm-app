// Unit tests for the shift-length sanity check.
//
//   npm test        (node --test lib/*.test.ts)
//
// The anchor case is the real one: catering deal 25156 (Terrain) produced a
// shift running 2026-09-27 13:30 to 2026-09-28 15:30 — twenty-six hours — and
// it was published.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LONG_SHIFT_HOURS,
  describeLongShift,
  findLongShifts,
  formatHours,
  formatInstant,
  isLongShift,
  shiftHours,
  type ShiftForLengthCheck,
} from "./shiftChecks.ts";

// The Terrain shift, as stored: 13:30 EDT on the 27th to 15:30 EDT on the 28th.
const TERRAIN_START = "2026-09-27T17:30:00Z"; // 13:30 EDT
const TERRAIN_END = "2026-09-28T19:30:00Z"; // 15:30 EDT

function edt(date: string, hhmm: string) {
  return `${date}T${hhmm}:00-04:00`;
}

test("the Terrain shift is 26 hours and is flagged", () => {
  assert.equal(shiftHours(TERRAIN_START, TERRAIN_END), 26);
  assert.equal(isLongShift(TERRAIN_START, TERRAIN_END), true);
});

test("the threshold is 15 hours and is inclusive", () => {
  assert.equal(LONG_SHIFT_HOURS, 15);
  const start = edt("2026-09-27", "08:00");
  assert.equal(isLongShift(start, edt("2026-09-27", "22:59")), false); // 14h59
  assert.equal(isLongShift(start, edt("2026-09-27", "23:00")), true); // exactly 15h
  assert.equal(isLongShift(start, edt("2026-09-28", "00:00")), true); // 16h
});

test("a shift a hair under the threshold is not rounded up into a refusal", () => {
  // 14 hours 59 minutes 58 seconds: displays as 15, but must not be flagged.
  const start = "2026-09-27T12:00:00Z";
  const end = "2026-09-28T02:59:58Z";
  assert.equal(shiftHours(start, end), 15);
  assert.equal(isLongShift(start, end), false);
});

test("ordinary shifts are left alone", () => {
  for (const [from, to] of [
    ["09:00", "17:00"],
    ["11:00", "23:00"],
    ["07:30", "20:30"],
  ]) {
    assert.equal(isLongShift(edt("2026-09-27", from), edt("2026-09-27", to)), false, `${from}-${to}`);
  }
});

test("a long overnight catering shift is still caught", () => {
  assert.equal(isLongShift(edt("2026-09-27", "18:00"), edt("2026-09-28", "10:00")), true); // 16h
});

test("backwards, equal and unparseable times are not 'long'", () => {
  assert.equal(isLongShift(TERRAIN_END, TERRAIN_START), false);
  assert.equal(isLongShift(TERRAIN_START, TERRAIN_START), false);
  assert.equal(isLongShift("not a date", TERRAIN_END), false);
  assert.equal(shiftHours(TERRAIN_END, TERRAIN_START), 0);
  assert.equal(shiftHours("not a date", TERRAIN_END), 0);
});

test("length is real elapsed time, so DST changes count", () => {
  // 20:00 EDT on 2026-10-31 to 10:00 EST on 2026-11-01: the clocks go back, so
  // the wall clock says 14 hours but the crew is there for 15.
  const start = "2026-10-31T20:00:00-04:00";
  const end = "2026-11-01T10:00:00-05:00";
  assert.equal(shiftHours(start, end), 15);
  assert.equal(isLongShift(start, end), true);

  // Spring forward the other way: 19:00 EST 2027-03-13 to 10:00 EDT 2027-03-14
  // reads as 15 hours on the clock but is only 14 worked.
  const springStart = "2027-03-13T19:00:00-05:00";
  const springEnd = "2027-03-14T10:00:00-04:00";
  assert.equal(shiftHours(springStart, springEnd), 14);
  assert.equal(isLongShift(springStart, springEnd), false);
});

test("findLongShifts returns only the bad ones, with their details", () => {
  const shifts: ShiftForLengthCheck[] = [
    { id: 1, employee_id: "emp-1", position: "PENN Opener", starts_at: edt("2026-09-27", "09:00"), ends_at: edt("2026-09-27", "17:00") },
    { id: 350, employee_id: null, position: "Catering", starts_at: TERRAIN_START, ends_at: TERRAIN_END },
    { id: 2, employee_id: "emp-2", position: "PENN Closer", starts_at: edt("2026-09-28", "15:00"), ends_at: edt("2026-09-28", "23:00") },
  ];
  assert.deepEqual(findLongShifts(shifts), [
    {
      id: 350,
      employee_id: null,
      position: "Catering",
      starts_at: TERRAIN_START,
      ends_at: TERRAIN_END,
      hours: 26,
    },
  ]);
});

test("findLongShifts copes with missing id, employee and position", () => {
  const [found] = findLongShifts([{ starts_at: TERRAIN_START, ends_at: TERRAIN_END }]);
  assert.equal(found.id, null);
  assert.equal(found.employee_id, null);
  assert.equal(found.position, null);
  assert.equal(found.hours, 26);
});

test("the check is not catering-specific", () => {
  const [found] = findLongShifts([
    { id: 9, position: "PENN Closer", starts_at: TERRAIN_START, ends_at: TERRAIN_END, employee_id: "emp-3" },
  ]);
  assert.equal(found.position, "PENN Closer");
  assert.match(describeLongShift(found), /^PENN Closer shift /);
});

test("the warning reads as plain English and names the position", () => {
  const [found] = findLongShifts([
    { id: 350, position: "Catering", employee_id: null, starts_at: TERRAIN_START, ends_at: TERRAIN_END },
  ]);
  assert.equal(
    describeLongShift(found),
    "Catering shift Sun Sep 27, 1:30 PM to Mon Sep 28, 3:30 PM is 26 hours long. Check the end time.",
  );
});

test("a shift with no position just says 'Shift'", () => {
  const [found] = findLongShifts([{ starts_at: TERRAIN_START, ends_at: TERRAIN_END }]);
  assert.match(describeLongShift(found), /^Shift Sun Sep 27, 1:30 PM /);
});

test("formatInstant renders New York wall clock", () => {
  assert.equal(formatInstant(TERRAIN_START), "Sun Sep 27, 1:30 PM");
  assert.equal(formatInstant(TERRAIN_END), "Mon Sep 28, 3:30 PM");
  assert.equal(formatInstant("2026-09-27T04:00:00Z"), "Sun Sep 27, 12:00 AM");
});

test("hours display without a pointless decimal", () => {
  assert.equal(formatHours(26), "26");
  assert.equal(formatHours(15), "15");
  assert.equal(formatHours(15.5), "15.5");
  assert.equal(formatHours(15.25), "15.25");
});
