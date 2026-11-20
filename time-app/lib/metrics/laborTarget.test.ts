// The Labor vs target metric (bj-finance #696), pinned as the manager reads
// it: each Sunday-to-Saturday week of a chosen month, with sales (in-store +
// delivery + catering), all labor all-in (hourly + salaried), actual %, the
// payroll target %, variance $ and variance hours (Alina, 2026-11-18).
// Round invented figures so each expectation can be checked by hand; crm-app
// is public, so nothing here is a real rate, wage or sale.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { DAYS_A_YEAR, laborVsTarget, laborWindow, type LaborDayRow, type LaborTargetInputs, type SalesDayRow } from "./laborTarget.ts";
import { monthWeeks } from "./weekRange.ts";
import { addDays, eachDay } from "./dates.ts";
import type { SalaryRow, SettingRow } from "../controlBoard/settings.ts";
import { boardOn } from "../controlBoard/board.ts";

const close = (a: number | null, b: number, msg?: string) => {
  assert.ok(a != null, msg ?? `expected ${b}, got null`);
  assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} expected ${b}, got ${a}`);
};

let nextId = 1;
const row = (key: string, value: number, detail: SettingRow["detail"] = {}, effective_from = "2030-01-01"): SettingRow => ({
  id: nextId++, key, value, detail, effective_from, review_by: "2031-12-31", source: "invented", method: null, recorded_by: null, recorded_at: `${effective_from}T00:00:00Z`,
});
const salary = (id: number, profile_id: string, annual_salary: number, effective_from = "2030-01-01"): SalaryRow => ({
  id, profile_id, annual_salary, effective_from, review_by: "2031-12-31", source: "invented", method: null, recorded_by: null, recorded_at: "2030-01-01T00:00:00Z",
});

// Sales estimate 800,000 + 200,000; payroll 25%; taxes and comp add 25% to
// wages (15% + 5% + 4% + $1 per $100). The card holds all labor to the 25%
// payroll target itself, never the hourly goal derived from it.
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
/** The weeks of OCT, as the card read them when it showed one month. */
const octWeeks = (i: LaborTargetInputs) => ({ weeks: laborVsTarget(monthWeeks(OCT), i) });
const TODAY = "2030-11-20";

// Each day: 10 hours, 150 wages + 10 solo close = 160, no catering or marketing work,
// x 1.25 with taxes and comp = 200. A week: 70 hours, 1,400.
const day = (d: string, over: Partial<LaborDayRow> = {}): LaborDayRow => ({
  day: d,
  hours: 10,
  wages: 150,
  catering_premium: 0,
  solo_close: 10,
  catering_hours: 0,
  catering_wages: 0,
  marketing_hours: 0,
  marketing_wages: 0,
  ...over,
});
/** inputs() with some days changed. */
const withDays = (over: Record<string, Partial<LaborDayRow>>, more: Partial<LaborTargetInputs> = {}) =>
  inputs({ labor: inputs().labor.map((r) => (over[r.day] ? { ...r, ...over[r.day] } : r)), ...more });
/** inputs() with some days' sales changed. */
const withSales = (over: Record<string, Partial<SalesDayRow>>, more: Partial<LaborTargetInputs> = {}) =>
  inputs({ sales: inputs().sales.map((r) => (over[r.day] ? { ...r, ...over[r.day] } : r)), ...more });

// A week's in-store sales of 4,100, unevenly spread, Sunday to Saturday, and
// 100 of delivery every day: 4,800 a week, 350 / 500 / 600 / 700 / 800 / 900 / 950.
const IN_STORE_DAY = [250, 400, 500, 600, 700, 800, 850];
const DELIVERY_DAY = 100;

function inputs(over: Partial<LaborTargetInputs> = {}): LaborTargetInputs {
  const days = eachDay("2030-09-29", "2030-11-02");
  return {
    today: TODAY,
    labor: days.map((d) => day(d)),
    sales: days.map((d) => ({ day: d, in_store: IN_STORE_DAY[new Date(`${d}T12:00:00Z`).getUTCDay()], delivery: DELIVERY_DAY })),
    catering: {},
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
  const weeks = octWeeks(inputs()).weeks;
  assert.deepEqual(weeks.map((w) => [w.start, w.end]), [
    ["2030-10-06", "2030-10-12"],
    ["2030-10-13", "2030-10-19"],
    ["2030-10-20", "2030-10-26"],
    ["2030-10-27", "2030-11-02"],
  ]);
});

test("a complete week: all labor with taxes and comp, against the payroll target on in-store + delivery + catering sales", () => {
  const w = octWeeks(inputs()).weeks[0];
  assert.equal(w.available, true);
  assert.deepEqual(w.why, []);
  close(w.sales, 4_800);
  close(w.inStoreSales, 4_100);
  close(w.deliverySales, 700);
  close(w.cateringSales, 0);
  close(w.hours, 70);
  close(w.hourlyHours, 70);
  close(w.hourly, 1_400); // (150 + 10) x 1.25 x 7
  close(w.salaried, 0); // nobody salaried
  close(w.actual, 1_400);
  close(w.actualPct, 1_400 / 4_800);
  close(w.goalPct.value, 0.25);
  close(w.targetPct.value, 0.25);
  close(w.cateringHours, 0);
  close(w.cateringCost, 0);
  close(w.marketingHours, 0);
  close(w.marketingOffset, 0);
  close(w.targetDollars, 1_200);
  close(w.varianceDollars, 200); // over target
  close(w.varianceHours, 10); // 200 at the week's 20 an hour
});

test("a week missing a day of payroll is not available, never zero; its sales and target still show", () => {
  const labor = inputs().labor.filter((r) => r.day !== "2030-10-15");
  const w = octWeeks(inputs({ labor })).weeks[1];
  assert.equal(w.available, false);
  assert.equal(w.hours, null);
  assert.equal(w.hourly, null);
  assert.equal(w.salaried, null);
  assert.equal(w.actual, null);
  assert.equal(w.actualPct, null);
  assert.equal(w.varianceDollars, null);
  assert.equal(w.varianceHours, null);
  close(w.sales, 4_800);
  close(w.targetPct.value, 0.25);
  assert.deepEqual(w.why, ["hourly payroll on file for 6 of 7 days"]);
  // The weeks around it are untouched.
  assert.equal(octWeeks(inputs({ labor })).weeks[0].available, true);
});

test("a week missing a day of sales has no sales, % or variance; its labor $ still shows", () => {
  const sales = inputs().sales.filter((r) => r.day !== "2030-10-22" && r.day !== "2030-10-23");
  const w = octWeeks(inputs({ sales })).weeks[2];
  assert.equal(w.available, false);
  assert.equal(w.sales, null);
  assert.equal(w.inStoreSales, null);
  assert.equal(w.deliverySales, null);
  assert.equal(w.cateringSales, null);
  assert.equal(w.actualPct, null);
  assert.equal(w.targetDollars, null);
  assert.equal(w.varianceDollars, null);
  close(w.actual, 1_400);
  close(w.targetPct.value, 0.25); // the same all week, so it shows without the sales
  assert.deepEqual(w.why, ["in-store sales on file for 5 of 7 days"]);
});

test("a day whose delivery is not on file makes the week's sales n/a, and says delivery, not in-store", () => {
  const w = octWeeks(withSales({ "2030-10-14": { delivery: null }, "2030-10-18": { delivery: null } })).weeks[1];
  assert.equal(w.available, false);
  assert.equal(w.sales, null);
  assert.equal(w.inStoreSales, null);
  assert.equal(w.deliverySales, null);
  assert.equal(w.actualPct, null);
  assert.equal(w.varianceDollars, null);
  close(w.actual, 1_400);
  assert.deepEqual(w.why, ["delivery sales on file for 5 of 7 days"]);
  // A day with no sales row at all is named as in-store; the delivery reason waits behind it.
  const sales = withSales({ "2030-10-18": { delivery: null } }).sales.filter((r) => r.day !== "2030-10-14");
  assert.deepEqual(octWeeks(inputs({ sales })).weeks[1].why, ["in-store sales on file for 6 of 7 days"]);
  // The weeks around it are untouched.
  assert.equal(octWeeks(withSales({ "2030-10-14": { delivery: null } })).weeks[0].available, true);
});

test("delivery of zero is on file, not missing", () => {
  const zero = Object.fromEntries(eachDay("2030-10-06", "2030-10-12").map((d) => [d, { delivery: 0 }]));
  const w = octWeeks(withSales(zero)).weeks[0];
  assert.equal(w.available, true, w.why.join("; "));
  close(w.deliverySales, 0);
  close(w.sales, 4_100);
});

test("a week not over yet is not available, whatever rows it has", () => {
  const w = octWeeks(inputs({ today: "2030-10-30" })).weeks[3];
  assert.equal(w.available, false);
  assert.equal(w.actual, null);
  assert.equal(w.sales, null);
  assert.deepEqual(w.why, ["the week is not over yet"]);
  // A week ending yesterday is over.
  assert.equal(octWeeks(inputs({ today: "2030-11-03" })).weeks[3].available, true);
});

test("each day is held to the payroll target in force that day", () => {
  // From Wednesday the 9th the payroll target is 20%.
  const settings = [...BOARD, row("target.payroll_pct", 0.2, {}, "2030-10-09")];
  const w = octWeeks(inputs({ settings })).weeks[0];
  // Sun-Tue sales 350 + 500 + 600 = 1,450 at 25%; Wed-Sat 700 + 800 + 900 + 950 = 3,350 at 20%.
  close(w.targetDollars, 1_450 * 0.25 + 3_350 * 0.2);
  close(w.targetPct.value, (1_450 * 0.25 + 3_350 * 0.2) / 4_800);
  assert.equal(w.goalPct.value, null); // not one target all week
  assert.deepEqual(w.goalPct.needs, ["the week's sales (the target changed during the week)"]);
  close(w.varianceDollars, 1_400 - 1_032.5);
  // Without the week's sales a changing target cannot be shown as one %.
  const sales = inputs().sales.filter((r) => r.day !== "2030-10-07");
  const noSales = octWeeks(inputs({ settings, sales })).weeks[0];
  assert.equal(noSales.targetPct.value, null);
  assert.deepEqual(noSales.targetPct.needs, ["the week's sales (the target changed during the week)"]);
});

test("taxes and comp on hourly labor are the rates in force on each day", () => {
  // From Thursday the 10th FICA is 25%: those three days carry 35%, so 160 x 1.35 = 216.
  const settings = [...BOARD, row("tax.fica", 0.25, { wage_cap: null }, "2030-10-10")];
  const w = octWeeks(inputs({ settings })).weeks[0];
  close(w.hourly, 4 * 200 + 3 * 216);
  close(w.actual, 4 * 200 + 3 * 216);
});

test("an empty control board: the target is missing with what it needs, the sales and hours still show", () => {
  const w = octWeeks(inputs({ settings: [] })).weeks[0];
  assert.equal(w.targetPct.value, null);
  assert.ok(w.targetPct.needs.includes("Total payroll target"));
  assert.equal(w.goalPct.value, null);
  assert.equal(w.hourly, null); // the taxes and comp are board values too
  assert.equal(w.actual, null);
  assert.deepEqual(w.why, ["payroll tax and workers' comp rates not set on the control board"]);
  close(w.sales, 4_800);
  close(w.hours, 70);
});

test("the days read: from the first week on offer to the Saturday of this week", () => {
  assert.deepEqual(laborWindow("2026-10-18"), { from: "2026-05-03", to: "2026-10-24" });
  assert.equal(addDays(monthWeeks("2030-02").at(-1)!, 6), "2030-03-02");
});

// ---------------------------------------------------------------------------
// Ruling 2026-11-18 (Alina): all labor, salaried and hourly, against the
// board's total payroll target; taxes and comp on both sides.
// ---------------------------------------------------------------------------

test("salaried labor is the board's fixed payroll, a 365th a day, and the target is the total payroll target, not the hourly goal", () => {
  // One salaried person on 29,200: fixed payroll 29,200 x 1.25 = 36,500 a year (no caps set), 100 a day.
  const salaries = [salary(1, "s1", 29_200)];
  const salaried = [{ id: "s1", name: "Person S" }];
  const w = octWeeks(inputs({ salaries, salaried })).weeks[0];
  const board = boardOn("2030-10-06", BOARD, salaries, salaried);
  close(board.fixedPayroll.value, 36_500);
  close(board.payrollTargetPct.value, 0.25);
  assert.ok(board.hourlyAllInPct.value! < 0.25, "the hourly goal is lower: fixed payroll comes out of it");
  assert.equal(DAYS_A_YEAR, 365);
  assert.equal(w.available, true, w.why.join("; "));
  close(w.salaried, 700);
  close(w.hourly, 1_400);
  close(w.actual, 2_100);
  close(w.actualPct, 2_100 / 4_800);
  close(w.goalPct.value, 0.25);
  close(w.targetPct.value, 0.25);
  close(w.targetDollars, 1_200);
  close(w.varianceDollars, 900);
  // Variance hours are at the hourly cost per hour (1,400 / 70 = 20), not all labor's: salaried hours do not move.
  close(w.varianceHours, 45);
});

test("salaried labor uses the board's wage caps on salaried taxes", () => {
  // FICA capped at 10,000 of pay: 1,500 instead of 4,380 on a 29,200 salary.
  const settings = BOARD.map((r) => (r.key === "tax.fica" ? { ...r, detail: { wage_cap: 10_000 } } : r));
  const salaries = [salary(1, "s1", 29_200)];
  const salaried = [{ id: "s1", name: "Person S" }];
  const w = octWeeks(inputs({ settings, salaries, salaried })).weeks[0];
  const fixed = 29_200 + 1_500 + 29_200 * 0.1;
  close(boardOn("2030-10-06", settings, salaries, salaried).fixedPayroll.value, fixed);
  close(w.salaried, (7 * fixed) / 365);
  close(w.hourly, 1_400); // hourly wages carry the full rates, no caps
});

test("someone in fixed payroll with no salary on file makes the week's labor n/a and names what the board needs", () => {
  const w = octWeeks(inputs({ salaried: [{ id: "s1", name: "Person S" }] })).weeks[0];
  assert.equal(w.available, false);
  assert.equal(w.salaried, null);
  assert.equal(w.actual, null);
  assert.equal(w.actualPct, null);
  assert.equal(w.varianceDollars, null);
  close(w.hourly, 1_400); // the hourly side still shows
  close(w.sales, 4_800);
  assert.deepEqual(w.why, ["salaried payroll needs Person S's salary"]);
  // With the rates missing too, the rates are named once, not again as a salaried need.
  const bare = octWeeks(inputs({ settings: [], salaried: [{ id: "s1", name: "Person S" }] })).weeks[0];
  assert.deepEqual(bare.why, ["payroll tax and workers' comp rates not set on the control board"]);
});

test("a salaried person hired after the week is not in that week's labor; someone salaried then is", () => {
  // Person S: 29,200, 100 a day all-in. Person T: 43,800 from the 20th, 150 a day all-in.
  const salaries = [salary(1, "s1", 29_200), salary(2, "s2", 43_800, "2030-10-20")];
  const salaried = [{ id: "s1", name: "Person S", archivedOn: "2030-10-25" }, { id: "s2", name: "Person T", archivedOn: null }];
  const weeks = octWeeks(inputs({ salaries, salaried })).weeks;
  assert.equal(weeks[0].available, true, weeks[0].why.join("; "));
  close(weeks[0].salaried, 700, "only Person S");
  // Oct 20-26: both from the 20th, Person S through the 25th, the archive day: 6 x 250 + 150.
  close(weeks[2].salaried, 1_650, "Person S counted through the archive day, not after");
  // After the 25th only Person T.
  close(weeks[3].salaried, 1_050);
  // The target is the payroll target whoever is salaried.
  for (const w of weeks) close(w.targetPct.value, 0.25);
});

// ---------------------------------------------------------------------------
// Ruling 2026-11-18 (Alina): catering crew work counts. Its sales count
// (booked deals by event date), so its labor does too; this reverses the
// 2026-11-16 exclusion.
// ---------------------------------------------------------------------------

test("the catering work recorded stays in hourly labor, premium and all, with that day's taxes and comp", () => {
  // Tuesday the 8th: 4 of its 10 hours were catering, paid 60 in wages (already in the 150) and 20 of premium.
  // Hourly: 6 x 200 + (150 + 20 + 10) x 1.25 = 1,425. The deal booked for that day sold 500.
  const w = octWeeks(withDays({ "2030-10-08": { catering_hours: 4, catering_wages: 60, catering_premium: 20 } }, { catering: { "2030-10-08": 500 } })).weeks[0];
  assert.equal(w.available, true, w.why.join("; "));
  close(w.hours, 70);
  close(w.hourlyHours, 70); // catering hours are not taken off
  close(w.cateringHours, 4);
  close(w.cateringCost, 100); // (60 + 20) x 1.25: shown, counted
  close(w.hourly, 1_425);
  close(w.actual, 1_425);
  close(w.cateringSales, 500);
  close(w.sales, 5_300);
  close(w.actualPct, 1_425 / 5_300);
  close(w.targetDollars, 5_300 * 0.25);
  close(w.varianceDollars, 100);
  close(w.varianceHours, 100 / (1_425 / 70));
  // The other weeks gain nothing.
  close(octWeeks(withDays({ "2030-10-08": { catering_hours: 4, catering_wages: 60, catering_premium: 20 } })).weeks[1].actual, 1_400);
});

test("the catering premium is in the actual, whatever day it was spread over", () => {
  const premiums = Object.fromEntries(eachDay("2030-10-06", "2030-10-12").map((d) => [d, { catering_premium: 6 }]));
  const w = octWeeks(withDays(premiums)).weeks[0];
  close(w.hourly, 7 * (166 * 1.25));
  close(w.actual, 1_452.5);
  close(w.cateringCost, 42 * 1.25);
});

test("catering sales count on their event day, held to that day's target, and never change the labor side", () => {
  // Friday the 11th: a 1,000 event. Sunday the 13th: a 400 event, the next week's.
  const settings = [...BOARD, row("target.payroll_pct", 0.2, {}, "2030-10-09")];
  const weeks = octWeeks(inputs({ settings, catering: { "2030-10-11": 1_000, "2030-10-13": 400 } })).weeks;
  close(weeks[0].cateringSales, 1_000);
  close(weeks[0].sales, 5_800);
  close(weeks[0].inStoreSales, 4_100);
  close(weeks[0].targetDollars, 1_450 * 0.25 + (3_350 + 1_000) * 0.2);
  close(weeks[0].hourly, 1_400);
  close(weeks[1].cateringSales, 400);
  close(weeks[1].sales, 5_200);
  close(weeks[2].cateringSales, 0);
});

test("when catering takes up every hour paid, the week still counts: catering hours are hourly hours", () => {
  const all = Object.fromEntries(eachDay("2030-10-06", "2030-10-12").map((d) => [d, { catering_hours: 10, catering_wages: 150 }]));
  const w = octWeeks(withDays(all)).weeks[0];
  assert.equal(w.available, true, w.why.join("; "));
  close(w.hourlyHours, 70);
  close(w.cateringHours, 70);
  close(w.cateringCost, 7 * 150 * 1.25);
  close(w.hourly, 1_400);
  close(w.varianceHours, 10);
});

test("a day whose catering work is not yet split out of the payroll makes the week's labor n/a, never zero", () => {
  const w = octWeeks(withDays({ "2030-10-15": { catering_hours: null, catering_wages: null } })).weeks[1];
  assert.equal(w.available, false);
  assert.equal(w.hourly, null);
  assert.equal(w.actual, null);
  assert.equal(w.cateringHours, null);
  assert.equal(w.cateringCost, null);
  assert.equal(w.hourlyHours, null);
  // The count is of the days NOT yet split: one here.
  assert.deepEqual(w.why, ["catering and marketing work not yet split out of the payroll for 1 of 7 days"]);
  close(w.sales, 4_800);
  close(w.hours, 70);
  close(w.targetPct.value, 0.25);
  assert.equal(octWeeks(withDays({ "2030-10-15": { catering_hours: null, catering_wages: null } })).weeks[0].available, true);
});

// ---------------------------------------------------------------------------
// Ruling 2026-11-16 (Alina), kept 2026-11-18: marketing work is a separate
// marketing budget with no sales of its own, taken off at the hours worked.
// ---------------------------------------------------------------------------

test("the marketing work recorded comes off hourly labor at what it was paid; catering on the same day stays in", () => {
  // Tuesday the 8th: 3 of its 10 hours were catering (paid 45, and 9 of premium), 5 were marketing (paid 75).
  // Tuesday's hourly: (150 - 75 + 9 + 10) x 1.25 = 117.50; the week 6 x 200 + 117.50 = 1,317.50.
  const w = octWeeks(
    withDays({ "2030-10-08": { catering_hours: 3, catering_wages: 45, catering_premium: 9, marketing_hours: 5, marketing_wages: 75 } }),
  ).weeks[0];
  assert.equal(w.available, true, w.why.join("; "));
  close(w.hours, 70);
  close(w.hourlyHours, 65); // marketing hours off, catering hours in
  close(w.cateringHours, 3);
  close(w.marketingHours, 5);
  close(w.cateringCost, 67.5); // (45 + 9) x 1.25, counted
  close(w.marketingOffset, 93.75); // 75 x 1.25: the premium is catering's alone
  close(w.hourly, 1_317.5);
  close(w.actual, 1_317.5);
  close(w.actualPct, 1_317.5 / 4_800);
  close(w.targetPct.value, 0.25);
  close(w.varianceDollars, 117.5);
  close(w.varianceHours, 117.5 / (1_317.5 / 65));
});

test("the marketing work on a day comes off with that day's taxes and comp", () => {
  // From Thursday the 10th FICA is 25%, so taxes and comp are 35%. Friday the 11th: 5 hours of marketing, paid 75.
  // All-in that is 75 x 1.35 = 101.25; the week without it was 4 x 200 + 3 x 216 = 1,448.
  const settings = [...BOARD, row("tax.fica", 0.25, { wage_cap: null }, "2030-10-10")];
  const w = octWeeks(withDays({ "2030-10-11": { marketing_hours: 5, marketing_wages: 75 } }, { settings })).weeks[0];
  assert.equal(w.available, true, w.why.join("; "));
  close(w.marketingOffset, 101.25);
  close(w.hourly, 1_346.75);
  close(w.actual, 1_346.75);
});

test("a day whose marketing work is not yet split makes the week's labor n/a, and the reason counts the days not split", () => {
  const unsplit = { marketing_hours: null, marketing_wages: null };
  const w = octWeeks(withDays({ "2030-10-15": unsplit, "2030-10-16": unsplit, "2030-10-17": unsplit })).weeks[1];
  assert.equal(w.available, false);
  assert.equal(w.actual, null);
  assert.equal(w.marketingHours, null);
  assert.equal(w.marketingOffset, null);
  assert.equal(w.cateringHours, null);
  assert.deepEqual(w.why, ["catering and marketing work not yet split out of the payroll for 3 of 7 days"]);
  const none = Object.fromEntries(eachDay("2030-10-13", "2030-10-19").map((d) => [d, unsplit]));
  assert.deepEqual(octWeeks(withDays(none)).weeks[1].why, ["catering and marketing work not yet split out of the payroll for 7 of 7 days"]);
});

test("when marketing takes up every hour paid, the week is n/a and says why, never a variance in hours", () => {
  const all = Object.fromEntries(eachDay("2030-10-06", "2030-10-12").map((d) => [d, { marketing_hours: 10, marketing_wages: 140 }]));
  const w = octWeeks(withDays(all)).weeks[0];
  assert.equal(w.available, false);
  assert.equal(w.varianceHours, null);
  close(w.hourlyHours, 0);
  assert.ok(w.why.includes("no hourly hours left once the marketing work is taken off"), w.why.join("; "));
});

test("when the marketing work leaves hourly labor at zero or less, the week is n/a and says why", () => {
  // 1,120 of pay, 1,200 of it marketing: -80, -100 all-in, with 65 hourly hours left.
  const w = octWeeks(withDays({ "2030-10-08": { marketing_hours: 5, marketing_wages: 1_200 } })).weeks[0];
  close(w.hourly, -100);
  close(w.hourlyHours, 65);
  assert.equal(w.available, false);
  assert.equal(w.varianceHours, null);
  assert.deepEqual(w.why, ["hourly labor is zero or less once the marketing work is taken off"]);
});
