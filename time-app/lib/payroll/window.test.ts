// Unit tests for the pay window (payroll spec §0.1).
//
//   npm test        (node --test — Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  currentPayWindow,
  mostRecentSunday,
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

test("0.1: the most recent Sunday from mid-week, and from a Sunday itself", () => {
  assert.equal(mostRecentSunday("2026-09-23"), "2026-09-20"); // Wednesday
  assert.equal(mostRecentSunday("2026-09-21"), "2026-09-20"); // Monday
  // Run ON the Sunday it returns that Sunday: the period ends at the end of
  // that day, and the run happens after it.
  assert.equal(mostRecentSunday("2026-09-20"), "2026-09-20");
});

test("0.1: the default window on the 2026-09-23 pay day is the run that actually happened", () => {
  const w = currentPayWindow("2026-09-23");
  assert.deepEqual(w, { start: "2026-09-07", end: "2026-09-20", payDate: "2026-09-23" });
});

test("0.1 crossing a year: the arithmetic is calendar days, not month maths", () => {
  const result = payWindowEnding("2027-01-03");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.window.start, "2026-12-21");
  assert.equal(result.window.payDate, "2027-01-06");
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
