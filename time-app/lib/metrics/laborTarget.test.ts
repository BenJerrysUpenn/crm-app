// The Labor vs target metric (bj-finance #696), pinned as the manager reads
// it: each Sunday-to-Saturday week of a chosen month, with actual sales,
// actual hourly labor $, actual %, target %, variance $ and variance hours.
// Round invented figures so each expectation can be checked by hand; crm-app
// is public, so nothing here is a real rate, wage or sale.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultLaborMonth, laborMonths, laborVsTarget, monthWeeks, type LaborDayRow, type LaborTargetInputs } from "./laborTarget.ts";
import { addDays, eachDay } from "./dates.ts";
import type { SettingRow } from "../controlBoard/settings.ts";

const close = (a: number | null, b: number, msg?: string) => {
  assert.ok(a != null, msg ?? `expected ${b}, got null`);
  assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} expected ${b}, got ${a}`);
};

let nextId = 1;
const row = (key: string, value: number, detail: SettingRow["detail"] = {}, effective_from = "2030-01-01"): SettingRow => ({
  id: nextId++, key, value, detail, effective_from, review_by: "2031-12-31", source: "invented", method: null, recorded_by: null, recorded_at: `${effective_from}T00:00:00Z`,
});

// Sales 800,000 + 200,000; payroll 25%; taxes and comp add 25% to wages
// (15% + 5% + 4% + $1 per $100). Nobody salaried: 250,000 / 1.25 = 200,000
// of hourly wages, an hourly goal of 20% of sales. With the taxes and comp on
// those wages that is 25% of sales: the target the card compares against.
const BOARD: SettingRow[] = [
  row("sales_estimate.in_store", 800_000),
  row("sales_estimate.catering", 200_000),
  row("target.payroll_pct", 0.25),
  row("tax.fica", 0.15, { wage_cap: null }),
  row("tax.futa", 0.05, { wage_cap: null }),
  row("tax.pa_uc", 0.04, { wage_cap: null }),
  row("tax.workers_comp", 1),
];

// October 2030 starts on a Tuesday: its Sundays are the 6th, 13th, 20th and 27th.
const OCT = "2030-10";
const TODAY = "2030-11-20";

// Each day: 10 hours, 150 wages + 6 catering premium + 4 solo close = 160,
// x 1.25 with taxes and comp = 200. A week: 70 hours, 1,400.
const day = (d: string, over: Partial<LaborDayRow> = {}): LaborDayRow => ({ day: d, hours: 10, wages: 150, catering_premium: 6, solo_close: 4, ...over });

// A week's sales of 4,800, unevenly spread, Sunday to Saturday.
const SALES_DAY = [300, 500, 600, 700, 800, 900, 1000];

function inputs(over: Partial<LaborTargetInputs> = {}): LaborTargetInputs {
  const days = eachDay("2030-09-29", "2030-11-02");
  return {
    today: TODAY,
    labor: days.map((d) => day(d)),
    sales: days.map((d) => ({ day: d, in_store: SALES_DAY[new Date(`${d}T12:00:00Z`).getUTCDay()] })),
    settings: BOARD,
    salaries: [],
    salaried: [],
    ...over,
  };
}

test("a month's weeks are the Sunday-to-Saturday weeks that start in it", () => {
  assert.deepEqual(monthWeeks("2030-10"), ["2030-10-06", "2030-10-13", "2030-10-20", "2030-10-27"]);
  // A month that starts on a Sunday has its first week on the 1st; its last runs into the next month.
  assert.deepEqual(monthWeeks("2026-11"), ["2026-11-01", "2026-11-08", "2026-11-15", "2026-11-22", "2026-11-29"]);
  const weeks = laborVsTarget(OCT, inputs()).weeks;
  assert.deepEqual(weeks.map((w) => [w.start, w.end]), [
    ["2030-10-06", "2030-10-12"],
    ["2030-10-13", "2030-10-19"],
    ["2030-10-20", "2030-10-26"],
    ["2030-10-27", "2030-11-02"],
  ]);
});

test("a complete week: actual labor with taxes and comp, against the hourly goal with its taxes and comp", () => {
  const w = laborVsTarget(OCT, inputs()).weeks[0];
  assert.equal(w.available, true);
  assert.deepEqual(w.why, []);
  close(w.sales, 4_800);
  close(w.hours, 70);
  close(w.wages, 1_050);
  close(w.premium, 42);
  close(w.solo, 28);
  close(w.taxesWc, 280); // 1,120 x 25%
  close(w.actual, 1_400);
  close(w.actualPct, 1_400 / 4_800);
  close(w.hourlyGoalPct.value, 0.2);
  close(w.targetPct.value, 0.25);
  close(w.targetDollars, 1_200);
  close(w.varianceDollars, 200); // over target
  close(w.varianceHours, 10); // 200 at the week's 20 an hour
});

test("a week missing a day of payroll is not available, never zero; its sales and target still show", () => {
  const labor = inputs().labor.filter((r) => r.day !== "2030-10-15");
  const w = laborVsTarget(OCT, inputs({ labor })).weeks[1];
  assert.equal(w.available, false);
  assert.equal(w.hours, null);
  assert.equal(w.actual, null);
  assert.equal(w.actualPct, null);
  assert.equal(w.varianceDollars, null);
  assert.equal(w.varianceHours, null);
  close(w.sales, 4_800);
  close(w.targetPct.value, 0.25);
  assert.deepEqual(w.why, ["hourly payroll on file for 6 of 7 days"]);
  // The weeks around it are untouched.
  assert.equal(laborVsTarget(OCT, inputs({ labor })).weeks[0].available, true);
});

test("a week missing a day of sales has no sales, % or variance; its labor $ still shows", () => {
  const sales = inputs().sales.filter((r) => r.day !== "2030-10-22" && r.day !== "2030-10-23");
  const w = laborVsTarget(OCT, inputs({ sales })).weeks[2];
  assert.equal(w.available, false);
  assert.equal(w.sales, null);
  assert.equal(w.actualPct, null);
  assert.equal(w.targetDollars, null);
  assert.equal(w.varianceDollars, null);
  close(w.actual, 1_400);
  close(w.targetPct.value, 0.25); // the same all week, so it shows without the sales
  assert.deepEqual(w.why, ["in-store sales on file for 5 of 7 days"]);
});

test("a week not over yet is not available, whatever rows it has", () => {
  const w = laborVsTarget(OCT, inputs({ today: "2030-10-30" })).weeks[3];
  assert.equal(w.available, false);
  assert.equal(w.actual, null);
  assert.equal(w.sales, null);
  assert.deepEqual(w.why, ["the week is not over yet"]);
  // A week ending yesterday is over.
  assert.equal(laborVsTarget(OCT, inputs({ today: "2030-11-03" })).weeks[3].available, true);
});

test("each day is held to the target in force that day", () => {
  // From Wednesday the 9th the payroll target is 20%: 200,000 / 1.25 = 160,000, a 16% goal, 20% with taxes and comp.
  const settings = [...BOARD, row("target.payroll_pct", 0.2, {}, "2030-10-09")];
  const w = laborVsTarget(OCT, inputs({ settings })).weeks[0];
  // Sun-Tue sales 300 + 500 + 600 = 1,400 at 25%; Wed-Sat 700 + 800 + 900 + 1,000 = 3,400 at 20%.
  close(w.targetDollars, 1_400 * 0.25 + 3_400 * 0.2);
  close(w.targetPct.value, (1_400 * 0.25 + 3_400 * 0.2) / 4_800);
  assert.equal(w.hourlyGoalPct.value, null); // not one goal all week
  close(w.varianceDollars, 1_400 - 1_030);
  // Without the week's sales a changing target cannot be shown as one %.
  const sales = inputs().sales.filter((r) => r.day !== "2030-10-07");
  const noSales = laborVsTarget(OCT, inputs({ settings, sales })).weeks[0];
  assert.equal(noSales.targetPct.value, null);
  assert.deepEqual(noSales.targetPct.needs, ["the week's sales (the target changed during the week)"]);
});

test("taxes and comp on actual labor are the rates in force on each day", () => {
  // From Thursday the 10th FICA is 25%: those three days carry 35%, so 160 x 1.35 = 216.
  const settings = [...BOARD, row("tax.fica", 0.25, { wage_cap: null }, "2030-10-10")];
  const w = laborVsTarget(OCT, inputs({ settings })).weeks[0];
  close(w.taxesWc, 4 * 40 + 3 * 56);
  close(w.actual, 4 * 200 + 3 * 216);
});

test("an empty control board: the target is missing with what it needs, the actuals still show", () => {
  const w = laborVsTarget(OCT, inputs({ settings: [] })).weeks[0];
  assert.equal(w.targetPct.value, null);
  assert.ok(w.targetPct.needs.includes("Total payroll target"));
  assert.equal(w.actual, null); // the taxes and comp are board values too
  assert.ok(w.why.includes("payroll tax and workers' comp rates not set on the control board"));
  close(w.sales, 4_800);
  close(w.hours, 70);
});

test("months on offer: the current month and the 11 before it, newest first; the default is last month", () => {
  const months = laborMonths("2030-03-15");
  assert.equal(months.length, 12);
  assert.equal(months[0], "2030-03");
  assert.equal(months[11], "2029-04");
  assert.equal(defaultLaborMonth("2030-03-15"), "2030-02");
  assert.equal(defaultLaborMonth("2030-01-01"), "2029-12");
  assert.equal(addDays(monthWeeks("2030-02").at(-1)!, 6), "2030-03-02");
});
