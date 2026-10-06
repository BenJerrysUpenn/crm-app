// Unit tests for dropping past time-off requests from the Team availability page.
//
//   npm test        (node --test lib/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";

import { dropPastTimeOff, isPastTimeOff, todayInNewYork } from "./timeOff.ts";

test("isPastTimeOff: a request that ended yesterday is past", () => {
  assert.equal(isPastTimeOff("2026-09-28", "2026-09-29"), true);
});

test("isPastTimeOff: a request ending today is not past", () => {
  assert.equal(isPastTimeOff("2026-09-29", "2026-09-29"), false);
});

test("isPastTimeOff: a request ending later is not past", () => {
  assert.equal(isPastTimeOff("2026-10-03", "2026-09-29"), false);
});

test("isPastTimeOff: a row with no date is never past", () => {
  assert.equal(isPastTimeOff(null, "2026-09-29"), false);
});

test("todayInNewYork: 11:30 PM Eastern is still that day, though UTC is already tomorrow", () => {
  // 2026-09-29 23:30 EDT = 2026-09-30 03:30 UTC
  const now = new Date("2026-09-30T03:30:00Z");
  assert.equal(todayInNewYork(now), "2026-09-29");
  assert.equal(isPastTimeOff("2026-09-29", todayInNewYork(now)), false);
});

test("todayInNewYork: at midnight Eastern the day before becomes past", () => {
  // 2026-09-30 00:00 EDT = 2026-09-30 04:00 UTC
  const now = new Date("2026-09-30T04:00:00Z");
  assert.equal(todayInNewYork(now), "2026-09-30");
  assert.equal(isPastTimeOff("2026-09-29", todayInNewYork(now)), true);
});

test("todayInNewYork: the boundary follows standard time in winter", () => {
  // 2026-12-14 23:59 EST = 2026-12-15 04:59 UTC; midnight EST = 05:00 UTC
  assert.equal(todayInNewYork(new Date("2026-12-15T04:59:00Z")), "2026-12-14");
  assert.equal(todayInNewYork(new Date("2026-12-15T05:00:00Z")), "2026-12-15");
});

const row = (id: number, employee_id: string, request_group: string | null, specific_date: string | null) => ({
  id,
  employee_id,
  request_group,
  specific_date,
});

test("dropPastTimeOff: a multi-day request stays, all its days, until its last day has passed", () => {
  const rows = [row(1, "ann", "g1", "2026-09-27"), row(2, "ann", "g1", "2026-09-28"), row(3, "ann", "g1", "2026-09-29")];
  assert.deepEqual(dropPastTimeOff(rows, "2026-09-29"), rows);
  assert.deepEqual(dropPastTimeOff(rows, "2026-09-30"), []);
});

test("dropPastTimeOff: single-day requests are judged on their own day", () => {
  const past = row(1, "ann", null, "2026-09-28");
  const today = row(2, "ann", null, "2026-09-29");
  const later = row(3, "bob", "g2", "2026-10-05");
  assert.deepEqual(dropPastTimeOff([past, today, later], "2026-09-29"), [today, later]);
});

test("dropPastTimeOff: groups are per person, so one person's request does not keep another's alive", () => {
  const annOld = row(1, "ann", "same", "2026-09-01");
  const bobNew = row(2, "bob", "same", "2026-10-01");
  assert.deepEqual(dropPastTimeOff([annOld, bobNew], "2026-09-29"), [bobNew]);
});

test("dropPastTimeOff: a row with no date is kept", () => {
  const undated = row(1, "ann", null, null);
  assert.deepEqual(dropPastTimeOff([undated], "2026-09-29"), [undated]);
});
