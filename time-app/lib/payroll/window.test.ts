// Unit tests for the pay window (payroll spec §0.1).
//
//   npm test        (node --test — Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PERIOD_ANCHOR_END,
  currentPayWindow,
  firstSubmittalDay,
  isPeriodEnd,
  mostRecentPeriodEnd,
  periodEndFor,
  periodEndsCovering,
  periodEnded,
  payWeeks,
  payWindowEnding,
  weekdayOf,
  windowDates,
} from "./window.ts";

test("0.1: the period is the 14 days ending the most recent Sunday", () => {
  const result = payWindowEnding("2026-09-20");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(weekdayOf("2026-09-20"), 0, "2026-09-20 must be a Sunday for this fixture to mean anything");
  assert.equal(result.window.start, "2026-09-07");
  assert.equal(result.window.end, "2026-09-20");
  assert.equal(windowDates(result.window).length, 14);
});

test("0.1: the pay date is the period end + 3, a Wednesday", () => {
  const result = payWindowEnding("2026-09-20");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.window.payDate, "2026-09-23");
  assert.equal(weekdayOf(result.window.payDate), 3);
});

test("0.1: a window that does not end on a Sunday is refused, not rounded", () => {
  // Answering about a different fortnight than the one asked for is worse than
  // refusing: the person would never know which one they were looking at.
  const result = payWindowEnding("2026-09-22");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /end on a Sunday/);
});

test("0.1: a date that is not a date at all is refused", () => {
  assert.equal(payWindowEnding("2026-02-31").ok, false);
  assert.equal(payWindowEnding("last sunday").ok, false);
  assert.equal(payWindowEnding("").ok, false);
});

test("0.1: periods end every other Sunday, on the cycle through 2026-09-20 (ruled 2026-09-27)", () => {
  assert.equal(PERIOD_ANCHOR_END, "2026-09-20");
  for (const end of ["2026-09-06", "2026-09-20", "2026-10-04", "2026-10-18", "2026-11-01", "2027-01-10"]) {
    assert.equal(isPeriodEnd(end), true, `${end} is a period end`);
    assert.equal(payWindowEnding(end).ok, true, `${end} is accepted`);
  }
  for (const off of ["2026-09-13", "2026-09-27", "2026-10-11", "2027-01-03"]) {
    assert.equal(weekdayOf(off), 0, `${off} must be a Sunday for this fixture to mean anything`);
    assert.equal(isPeriodEnd(off), false, `${off} is the middle Sunday of a period`);
  }
});

test("0.1: an off-cycle Sunday is refused, and the error names the period it falls in", () => {
  const result = payWindowEnding("2026-09-27");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /every other Sunday/);
  assert.match(result.error, /2026-10-04/);
});

test("0.1: the default is the most recent period that has ENDED, never one still running", () => {
  // Monday 10-05 is the first day the 09-21 to 10-04 run can be worked.
  assert.equal(mostRecentPeriodEnd("2026-10-05"), "2026-10-04");
  // On the period's own last Sunday it has not ended: the previous one stands.
  assert.equal(mostRecentPeriodEnd("2026-10-04"), "2026-09-20");
  // The middle Sunday and the days around it belong to the running period.
  assert.equal(mostRecentPeriodEnd("2026-09-27"), "2026-09-20");
  assert.equal(mostRecentPeriodEnd("2026-09-21"), "2026-09-20");
  assert.equal(mostRecentPeriodEnd("2026-09-20"), "2026-09-06");
  assert.equal(mostRecentPeriodEnd("2026-10-18"), "2026-10-04");
});

test("0.1: the period a day belongs to ends on the next on-cycle Sunday", () => {
  assert.equal(periodEndFor("2026-09-20"), "2026-09-20");
  assert.equal(periodEndFor("2026-09-21"), "2026-10-04");
  assert.equal(periodEndFor("2026-09-27"), "2026-10-04");
  assert.equal(periodEndFor("2026-10-04"), "2026-10-04");
  assert.equal(periodEndFor("2026-09-07"), "2026-09-20");
  assert.equal(periodEndFor("2026-09-06"), "2026-09-06");
});

test("a schedule week (Sunday to Saturday) spans one period, or two when its Sunday ends one", () => {
  // 09-27 is a middle Sunday: the whole week is in the period ending 10-04.
  assert.deepEqual(periodEndsCovering("2026-09-27", "2026-10-03"), ["2026-10-04"]);
  // 10-04 ends a period: that Sunday is paid in it, Monday on in the next.
  assert.deepEqual(periodEndsCovering("2026-10-04", "2026-10-10"), ["2026-10-04", "2026-10-18"]);
});

test("0.1: the default window on the 2026-09-23 pay day is the run that actually happened", () => {
  const w = currentPayWindow("2026-09-23");
  assert.deepEqual(w, { start: "2026-09-07", end: "2026-09-20", payDate: "2026-09-23" });
});

test("0.1: the first live run, worked Monday 2026-10-05, is 09-21 to 10-04 and pays Wednesday 10-07", () => {
  const w = currentPayWindow("2026-10-05");
  assert.deepEqual(w, { start: "2026-09-21", end: "2026-10-04", payDate: "2026-10-07" });
  assert.equal(weekdayOf(w.payDate), 3);
});

test("0.1 crossing a year: the arithmetic is calendar days, not month maths", () => {
  const result = payWindowEnding("2027-01-10");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.window.start, "2026-12-28");
  assert.equal(result.window.payDate, "2027-01-13");
});

test("2.3: the fortnight splits into two Monday-to-Sunday weeks, never summed for overtime", () => {
  const result = payWindowEnding("2026-09-20");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(payWeeks(result.window), [
    { start: "2026-09-07", end: "2026-09-13" },
    { start: "2026-09-14", end: "2026-09-20" },
  ]);
});

test("a period has ended only after its Sunday, so a run is submittable from the Monday", () => {
  const w = currentPayWindow("2026-09-21");
  assert.equal(w.end, "2026-09-20");
  assert.equal(periodEnded(w, "2026-09-19"), false);
  assert.equal(periodEnded(w, "2026-09-20"), false);
  assert.equal(periodEnded(w, "2026-09-21"), true);
  assert.equal(firstSubmittalDay(w), "2026-09-21");
});
