// What the Labor vs target chart draws (bj-finance #696): a bar per week for
// actual %, the target line, over-target weeks picked out, n/a weeks left as
// gaps (never zero), and totals over complete weeks only. Invented figures;
// crm-app is public.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { laborTargetChart } from "./laborTargetChart.ts";
import type { LaborTargetWeek } from "./laborTarget.ts";

const pct = (v: number | null) => ({ value: v, needs: v == null ? ["Total payroll target"] : [] });

function wk(start: string, end: string, over: Partial<LaborTargetWeek> = {}): LaborTargetWeek {
  return {
    start, end, available: true, why: [], sales: 4_000, hours: 60, wages: 900, premium: 0, solo: 0, cateringHours: 0, cateringOffset: 0,
    taxesWc: 100, actual: 1_000, actualPct: 0.25, allInGoalPct: pct(0.2), targetPct: pct(0.2), targetDollars: 800, varianceDollars: 200, varianceHours: 10, ...over,
  };
}

const NA: Partial<LaborTargetWeek> = {
  available: false, why: ["hourly payroll on file for 3 of 7 days"], hours: null, wages: null, premium: null, solo: null, taxesWc: null,
  actual: null, actualPct: null, targetDollars: null, varianceDollars: null, varianceHours: null,
};

test("one mark per week, labelled by its Sunday; the target line follows each week's target", () => {
  const c = laborTargetChart([
    wk("2031-03-02", "2031-03-08"),
    wk("2031-03-09", "2031-03-15", { targetPct: pct(0.22) }),
    wk("2031-03-30", "2031-04-05", { targetPct: pct(null) }),
  ]);
  assert.deepEqual(c.labels, ["Mar 2", "Mar 9", "Mar 30"]);
  assert.deepEqual(c.actualPct, [0.25, 0.25, 0.25]);
  assert.deepEqual(c.targetPct, [0.2, 0.22, null]);
});

test("weeks over target are picked out; at or under target are not", () => {
  const c = laborTargetChart([
    wk("2031-03-02", "2031-03-08", { varianceDollars: 200 }),
    wk("2031-03-09", "2031-03-15", { varianceDollars: 0 }),
    wk("2031-03-16", "2031-03-22", { varianceDollars: -50 }),
  ]);
  assert.deepEqual(c.over, [0]);
});

test("a week without its numbers is a gap, never a zero bar, and is left out of the totals", () => {
  const c = laborTargetChart([
    wk("2031-03-02", "2031-03-08", { sales: 4_000, actual: 1_000, targetDollars: 800, varianceDollars: 200, varianceHours: 10 }),
    wk("2031-03-09", "2031-03-15", { sales: 6_000, actual: 1_080, actualPct: 0.18, targetDollars: 1_200, varianceDollars: -120, varianceHours: -6 }),
    wk("2031-03-16", "2031-03-22", { ...NA, sales: 9_000 }),
  ]);
  assert.equal(c.actualPct[2], null);
  assert.deepEqual(c.gaps, [2]);
  assert.deepEqual(c.over, [0]);
  assert.equal(c.totals.complete, 2);
  assert.equal(c.totals.weeks, 3);
  // (1,000 + 1,080) / (4,000 + 6,000); the n/a week's sales are not counted.
  assert.equal(c.totals.actualPct, 0.208);
  assert.equal(c.totals.targetPct, 0.2);
  assert.equal(c.totals.varianceDollars, 80);
  assert.equal(c.totals.varianceHours, 4);
});

test("a month with no complete week has no totals, only gaps", () => {
  const c = laborTargetChart([
    wk("2031-03-02", "2031-03-08", { ...NA, why: ["the week is not over yet"], sales: null }),
    wk("2031-03-09", "2031-03-15", { ...NA, why: ["the week is not over yet"], sales: null }),
  ]);
  assert.deepEqual(c.gaps, [0, 1]);
  assert.deepEqual(c.over, []);
  assert.deepEqual(c.totals, { complete: 0, weeks: 2, actualPct: null, targetPct: null, varianceDollars: null, varianceHours: null });
});

test("a week marked available but missing a figure does not count in the totals", () => {
  const c = laborTargetChart([wk("2031-03-02", "2031-03-08"), wk("2031-03-09", "2031-03-15", { targetDollars: null })]);
  assert.equal(c.totals.complete, 1);
  assert.equal(c.totals.actualPct, 0.25);
});
