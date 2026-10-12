// What the sales chart draws (bj-finance #671): cumulative month to date
// against the pace line, and months against their targets.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { lastN, periodCount, salesByMonth, salesMonthToDate } from "./series.ts";
import { SALES_TARGET_SEED } from "./salesTargetsSeed.ts";

const catering = { "2026-10-02": 1000, "2026-10-09": 500, "2026-10-20": 700, "2026-09-12": 300, "2026-12-05": 900 };

test("catering alone: cumulative to the as-of day, then nothing; pace to the catering target; progress", () => {
  const m = salesMonthToDate({ catering }, SALES_TARGET_SEED, "catering", "2026-10-10");
  assert.equal(m.days.length, 31);
  const c = m.cumulative[0].values;
  assert.equal(c[0], 0);
  assert.equal(c[1], 1000);
  assert.equal(c[9], 1500);
  assert.equal(c[10], null); // after today: booked events are not sales yet
  assert.equal(m.pace?.[30], 5450);
  assert.equal(m.progress?.paceToDate, 1758.06); // 5,450 x 10/31
  assert.equal(m.progress?.vsPace, -258.06);
  assert.deepEqual(m.waitingOn, []);
});

test("all streams with only catering in: no whole-business progress, and it says what it is waiting on", () => {
  const m = salesMonthToDate({ catering }, SALES_TARGET_SEED, "all", "2026-10-10");
  assert.equal(m.progress, null);
  assert.deepEqual(m.waitingOn, ["in_store", "concessions"]);
  assert.equal(m.actualSoFar, 1500);
  assert.equal(m.target?.amount, 35_099); // the tiles show the whole target
  assert.equal(m.pace?.[30], 5_450); // the chart sets catering against catering's target
  assert.equal(m.paceLabel, "Pace to catering target");
});

test("all streams once the feed is in: progress over the sum", () => {
  const in_store = { "2026-10-01": 2000, "2026-10-10": 1000 };
  const m = salesMonthToDate({ catering, in_store, concessions: {} }, SALES_TARGET_SEED, "all", "2026-10-10");
  assert.equal(m.progress?.actual, 4500);
  assert.equal(m.progress?.paceToDate, 11322.26);
});

test("by month: twelve back, three ahead; only catering is shown ahead; target per month, provisional flagged", () => {
  const m = salesByMonth({ catering, in_store: { "2026-10-01": 50 } }, SALES_TARGET_SEED, "all", "2026-10-10");
  assert.equal(m.months.length, 15);
  assert.equal(m.months[0], "2025-11-01");
  assert.equal(m.currentIndex, 11);
  const cat = m.actual.find((a) => a.stream === "catering")!.values;
  assert.equal(cat[10], 300); // September
  assert.equal(cat[11], 2200); // October, booked to the 20th included
  assert.equal(cat[13], 900); // December, booked
  const store = m.actual.find((a) => a.stream === "in_store")!.values;
  assert.equal(store[11], 50);
  assert.equal(store[12], null);
  // In-store and catering have data, concessions waits: the line is their targets.
  assert.equal(m.target[13], 16_834 + 3_944);
  assert.equal(m.targetLabel, "In-store and delivery and Catering target");
  assert.equal(m.provisional[13], true);
  const all = salesByMonth({ catering, in_store: {}, concessions: {} }, SALES_TARGET_SEED, "all", "2026-10-10");
  assert.equal(all.target[13], 25_778);
  assert.equal(all.targetLabel, "Target");
  assert.equal(m.target[0], null); // no 2025 targets
  assert.deepEqual(m.waitingOn, ["concessions"]);
});

test("a widget's period keeps that many of the latest weeks or months, or all there are", () => {
  const weeks = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10"];
  assert.deepEqual(lastN(weeks, periodCount("8w")), ["w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10"]);
  assert.deepEqual(lastN(["m1", "m2"], periodCount("12m")), ["m1", "m2"]);
  assert.equal(periodCount("13w"), 13);
  assert.equal(periodCount("mtd"), 0); // not a count
});
