// The Schedule page's labor line and day headers (bj-finance #695), pinned
// as the manager reads them. Round invented figures so each expectation can
// be checked by hand; crm-app is public, so nothing here is a real rate,
// salary or sale.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { trendFactor, type Derived, type MonthlySalesRow } from "./math.ts";
import { MISSING, scheduleLabor, type LaborPerson, type LaborShift, type ScheduleLaborInput } from "./schedule.ts";
import type { SalaryRow, SettingRow } from "./settings.ts";
import { addDays } from "../metrics/dates.ts";

const close = (a: number | null, b: number, msg?: string) => {
  assert.ok(a != null, msg ?? `expected ${b}, got null`);
  assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} expected ${b}, got ${a}`);
};
const val = (d: Derived) => d.value;

// The week of Sunday 2030-10-13. October in New York is UTC-4.
const WEEK = "2030-10-13";
const DATES = Array.from({ length: 7 }, (_, i) => addDays(WEEK, i));
const TODAY = "2030-10-10";
/** A New York wall-clock time on a day, as UTC ISO (EDT, UTC-4). */
const ny = (day: string, hhmm: string, nextDay = false) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(`${nextDay ? addDays(day, 1) : day}T00:00:00Z`);
  d.setUTCHours(h + 4, m);
  return d.toISOString();
};

let nextId = 1;
const row = (key: string, value: number, detail: SettingRow["detail"] = {}, effective_from = "2030-01-01"): SettingRow => ({
  id: nextId++, key, value, detail, effective_from, review_by: "2031-12-31", source: "invented", method: null, recorded_by: null, recorded_at: `${effective_from}T00:00:00Z`,
});

// Sales 800,000 + 200,000; payroll 25%; taxes and comp add 25% to wages
// (15% + 5% + 4% + $1 per $100). With nobody salaried: 250,000 / 1.25 =
// 200,000 of hourly wages, an hourly goal of 20%.
const BOARD: SettingRow[] = [
  row("sales_estimate.in_store", 800_000),
  row("sales_estimate.catering", 200_000),
  row("target.payroll_pct", 0.25),
  row("tax.fica", 0.15, { wage_cap: null }),
  row("tax.futa", 0.05, { wage_cap: null }),
  row("tax.pa_uc", 0.04, { wage_cap: null }),
  row("tax.workers_comp", 1),
  row("rule.catering_premium", 2, { cap_rate: 21 }),
  row("rule.solo_close", 30, { min_alone_hours: 4, out_at_or_after: "22:00" }),
];

// Trend: 11,000 last September over 10,000 the September before = 1.1.
const MONTHLY: MonthlySalesRow[] = [
  { month: "2030-09-01", source: "qbo", in_store: 11_000 },
  { month: "2029-09-01", source: "seller", in_store: 10_000 },
];

// Two active hourly people at 10 and 20: an average rate of 15.
const PEOPLE: LaborPerson[] = [
  { id: "ten", name: "Ten Hourly", hourly_rate: 10, pay_type: "hourly", active: true },
  { id: "twenty", name: "Twenty Hourly", hourly_rate: 20, pay_type: "hourly", active: true },
  { id: "sal", name: "Sal Salaried", hourly_rate: null, pay_type: "salaried", active: true },
];

const withPeople = (...extra: LaborPerson[]) => new Map([...PEOPLE, ...extra].map((p) => [p.id, p]));

// Last year: 1,000 of in-store sales on each of the seven matching weekdays.
const lastYear = (except: string[] = []) => new Map(DATES.map((d) => addDays(d, -364)).filter((d) => !except.includes(d)).map((d) => [d, 1_000]));

let shiftId = 1;
const shift = (employee_id: string | null, day: string, from: string, to: string, position: string | null = "Scooper", toNextDay = false): LaborShift => ({
  id: shiftId++, employee_id, starts_at: ny(day, from), ends_at: ny(day, to, toNextDay), position,
});

function input(over: Partial<ScheduleLaborInput> = {}): ScheduleLaborInput {
  return {
    dates: DATES,
    shifts: [],
    people: new Map(PEOPLE.map((p) => [p.id, p])),
    inStoreByName: new Map([["Scooper", true], ["Catering", false], ["Meeting", false]]),
    settings: BOARD,
    salaries: [] as SalaryRow[],
    salaried: [],
    trend: trendFactor(TODAY, MONTHLY, []),
    inStoreByDay: lastYear(),
    cateringByDay: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Day headers: all scheduled hours / that day's target hours
// ---------------------------------------------------------------------------

test("a day's target is last year's same weekday x trend plus this year's catering booked, x the hourly goal, / the average active hourly rate", () => {
  const l = scheduleLabor(input({ cateringByDay: { "2030-10-14": 400 } }));
  const sun = l.days[0];
  assert.equal(sun.lastYearDay, "2029-10-14", "52 weeks earlier: the same weekday");
  close(val(sun.trendedInStore), 1_100);
  close(val(sun.projectedSales), 1_100);
  close(val(sun.hourlyGoal), 0.2);
  close(val(sun.targetDollars), 220);
  close(val(sun.targetHours), 220 / 15);

  const mon = l.days[1];
  close(val(mon.projectedSales), 1_500, "1,000 x 1.1 + 400 of catering booked");
  close(val(mon.targetDollars), 300);
  close(val(mon.targetHours), 20);

  close(val(l.target.dollars), 220 * 6 + 300, "the week's target is the sum of its days");
  close(val(l.target.hours), (220 * 6 + 300) / 15);
  assert.equal(l.boardEmpty, false);
});

test("the day header counts ALL scheduled hours that day, whoever works them", () => {
  const l = scheduleLabor(input({
    shifts: [
      shift("ten", "2030-10-14", "12:00", "18:00"),
      shift("sal", "2030-10-14", "09:00", "17:00"),
      shift(null, "2030-10-14", "18:00", "22:00"),
      shift("nobody-active", "2030-10-14", "10:00", "11:00"),
    ],
  }));
  assert.equal(l.days[1].scheduledHours, 6 + 8 + 4 + 1);
  assert.equal(l.totalHours, 19);
});

test("target hours use the average of ACTIVE hourly staff, so swapping who works does not move them", () => {
  const before = scheduleLabor(input({ shifts: [shift("ten", "2030-10-14", "12:00", "20:00")] }));
  const after = scheduleLabor(input({ shifts: [shift("twenty", "2030-10-14", "12:00", "20:00")] }));
  assert.equal(val(before.days[1].targetHours), val(after.days[1].targetHours));
  close(before.labor.total, 80);
  close(after.labor.total, 160, "the dollars show the cost of who is picked");

  const withInactive = scheduleLabor(input({
    people: withPeople({ id: "gone", name: "Gone Hourly", hourly_rate: 100, pay_type: "hourly", active: false }),
  }));
  close(val(withInactive.avgRate), 15, "an inactive person is not in the average");
});

test("pay type is read strictly: an active person with pay type not set is not in the average rate", () => {
  const l = scheduleLabor(input({
    people: withPeople({ id: "unset", name: "Unset Person", hourly_rate: 100, pay_type: null, active: true }),
  }));
  close(val(l.avgRate), 15);
  assert.equal(l.avgRateOver, 2);
});

test("a day with no last-year sales on file shows its target as missing with the day it looked for, and the week's target is missing too", () => {
  const l = scheduleLabor(input({ inStoreByDay: lastYear(["2029-10-16"]) }));
  const tue = l.days[2];
  assert.equal(tue.targetHours.value, null);
  assert.deepEqual(tue.lastYearInStore.needs, ["no in-store sales on file for Tue, Oct 16, 2029"]);
  assert.equal(tue.short, "no last-year sales");
  assert.notEqual(l.days[1].targetHours.value, null, "the other days still have targets");
  assert.equal(l.target.hours.value, null, "never a week total that quietly counts the day as zero");
  assert.deepEqual(l.target.hours.needs, ["no in-store sales on file for Tue, Oct 16, 2029"]);
});

test("with nothing on the control board every target is missing and the page knows the board is empty", () => {
  const l = scheduleLabor(input({ settings: [] }));
  assert.equal(l.boardEmpty, true);
  for (const d of l.days) {
    assert.equal(d.targetHours.value, null);
    assert.equal(d.short, "board not set");
  }
  assert.ok(l.target.hours.needs.includes("Total payroll target"), "says which board value it needs");
  assert.equal(l.target.dollars.value, null);
});

test("a trend with a partial month is missing, not 1 and not 0", () => {
  const l = scheduleLabor(input({ trend: trendFactor(TODAY, [MONTHLY[1]], [{ day: "2030-09-01", in_store: 500, basis: "booked", source: "square" }]) }));
  assert.equal(l.trend.factor.value, null);
  assert.deepEqual(l.days[0].targetHours.needs, ["in-store sales for 2030-09"]);
  assert.equal(l.days[0].short, "no trend");
});

test("when the catering bookings cannot be read, projected sales are missing rather than counting no catering", () => {
  const l = scheduleLabor(input({ cateringByDay: null }));
  assert.equal(l.days[0].projectedSales.value, null);
  assert.deepEqual(l.days[0].projectedSales.needs, [MISSING.catering]);
  assert.equal(l.days[0].short, "catering unread");
});

test("with no active hourly staff on a rate, target hours are missing but target dollars still show", () => {
  const l = scheduleLabor(input({ people: new Map([["sal", PEOPLE[2]]]) }));
  close(val(l.days[0].targetDollars), 220);
  assert.equal(l.days[0].targetHours.value, null);
  assert.deepEqual(l.days[0].targetHours.needs, [MISSING.avgRate]);
  assert.equal(l.days[0].short, "no average rate");
});

test("with no active hourly staff on a rate, an open shift's $ is missing and the line says why, never $0", () => {
  const l = scheduleLabor(input({ people: new Map([["sal", PEOPLE[2]]]), shifts: [shift(null, "2030-10-14", "12:00", "16:00")] }));
  assert.equal(l.hourlyHours, 4);
  assert.equal(l.labor.total, 0);
  assert.equal(l.labor.none, true);
  assert.deepEqual(l.labor.notCounted, ["open shifts (4.0h): no active hourly staff with a rate on the Team page"]);
});

test("a board with sales estimates of zero says it needs a sales estimate above zero", () => {
  const settings = BOARD.map((r) => (r.key.startsWith("sales_estimate.") ? { ...r, value: 0 } : r));
  const l = scheduleLabor(input({ settings }));
  assert.equal(l.days[0].hourlyGoal.value, null);
  assert.deepEqual(l.days[0].hourlyGoal.needs, ["a sales estimate above zero"]);
  assert.equal(l.days[0].short, "board not set");
  assert.equal(l.boardEmpty, false, "values are on the board, just not usable");
});

test("the hourly goal is the board's as it stood on each day: a payroll target changed mid-week moves only the days after it", () => {
  const l = scheduleLabor(input({ settings: [...BOARD, row("target.payroll_pct", 0.3125, {}, "2030-10-16")] }));
  close(val(l.days[2].hourlyGoal), 0.2, "Tuesday still uses the old target");
  close(val(l.days[3].hourlyGoal), 0.25, "Wednesday on: 312,500 / 1.25 / 1,000,000");
});

test("salaried staff on the board come out of the hourly goal (fixed payroll first)", () => {
  // 50,000 salary + 25% taxes and comp = 62,500 fixed; (250,000 - 62,500) / 1.25 = 150,000: a 15% goal.
  const l = scheduleLabor(input({
    salaried: [{ id: "sal", name: "Sal Salaried" }],
    salaries: [{ id: 1, profile_id: "sal", annual_salary: 50_000, effective_from: "2030-01-01", review_by: "2031-01-01", source: "invented", method: null, recorded_by: null, recorded_at: "2030-01-01T00:00:00Z" }],
  }));
  close(val(l.days[0].hourlyGoal), 0.15);
});

// ---------------------------------------------------------------------------
// The week line: Total hours / Hourly labor: hours · $ / Target: hours · $
// ---------------------------------------------------------------------------

test("hourly labor $ is hourly hours x rate, plus the catering premium, plus solo-close bonuses, plus open shifts at the average rate; salaried left out", () => {
  const l = scheduleLabor(input({
    shifts: [
      shift("ten", "2030-10-14", "12:00", "20:00"), // 8h x 10 = 80
      shift("twenty", "2030-10-15", "10:00", "15:00", "Catering"), // 5h x 20 = 100, premium min(22, 21) - 20 = 1/h: 5
      shift("sal", "2030-10-15", "09:00", "17:00"), // salaried: in total hours only
      shift(null, "2030-10-16", "12:00", "16:00"), // open 4h x 15 = 60
    ],
  }));
  assert.equal(l.totalHours, 25);
  assert.equal(l.hourlyHours, 17, "hourly-paid and open hours; salaried left out");
  close(l.labor.wages, 180);
  close(l.labor.premium, 5, "the premium never takes pay past the cap");
  close(l.labor.open, 60);
  close(l.labor.solo, 0, "no night here has a closer out at or after the cut-off");
  close(l.labor.total, 245);
  assert.deepEqual(l.labor.notCounted, []);
  assert.equal(l.labor.none, false);
});

test("an open Catering shift gets the premium on the average rate", () => {
  const l = scheduleLabor(input({ shifts: [shift(null, "2030-10-15", "10:00", "14:00", "Catering")] }));
  close(l.labor.open, 4 * (15 + 2), "15 + 2 stays under the 21 cap");
});

test("the catering premium in force on the shift's date is used: a change mid-week applies from its date", () => {
  const settings = [...BOARD, row("rule.catering_premium", 3, { cap_rate: 30 }, "2030-10-16")];
  const l = scheduleLabor(input({
    settings,
    shifts: [shift("ten", "2030-10-15", "10:00", "12:00", "Catering"), shift("ten", "2030-10-16", "10:00", "12:00", "Catering")],
  }));
  close(l.labor.premium, 2 * 2 + 2 * 3);
});

test("solo close: the last in-store closer alone the board's hours or more, out at or after its cut-off, earns the board's bonus", () => {
  const night = "2030-10-17";
  const l = scheduleLabor(input({
    shifts: [
      shift("twenty", night, "12:00", "18:00"),
      shift("ten", night, "17:00", "22:30"), // alone 18:00-22:30 = 4.5h, out 22:30
      shift("twenty", night, "20:00", "23:30", "Catering"), // not in-store: does not close
    ],
  }));
  close(l.labor.solo, 30);

  const early = scheduleLabor(input({ shifts: [shift("ten", night, "15:00", "21:30")] }));
  close(early.labor.solo, 0, "out before the cut-off");

  const notAlone = scheduleLabor(input({ shifts: [shift("ten", night, "15:00", "23:00"), shift("twenty", night, "16:00", "21:00")] }));
  close(notAlone.labor.solo, 0, "alone only from 21:00: 2 hours");

  const pastMidnight = scheduleLabor(input({ shifts: [shift("ten", night, "19:00", "00:30", "Scooper", true)] }));
  close(pastMidnight.labor.solo, 30, "a close after midnight is still that night");

  const salaried = scheduleLabor(input({ shifts: [shift("sal", night, "17:00", "23:00")] }));
  close(salaried.labor.solo, 0, "a salaried closer is not hourly labor");

  const open = scheduleLabor(input({ shifts: [shift(null, night, "17:00", "23:00")] }));
  close(open.labor.solo, 30, "an open closing shift will be someone hourly");
});

test("with no premium or solo-close rule on the board, the $ shows what it has and says what it left out, never counting them as zero silently", () => {
  const settings = BOARD.filter((r) => !r.key.startsWith("rule."));
  const l = scheduleLabor(input({
    settings,
    shifts: [shift("ten", "2030-10-14", "12:00", "20:00"), shift("ten", "2030-10-15", "10:00", "12:00", "Catering")],
  }));
  close(l.labor.total, 100);
  assert.deepEqual(l.labor.notCounted, [MISSING.premium, MISSING.solo]);
  assert.equal(l.labor.none, false);
});

test("an hourly person with no rate: their hours are hourly hours, their $ is listed as not counted", () => {
  const l = scheduleLabor(input({
    people: withPeople({ id: "norate", name: "No Rate", hourly_rate: null, pay_type: "hourly", active: true }),
    shifts: [shift("norate", "2030-10-14", "12:00", "18:00")],
  }));
  assert.equal(l.hourlyHours, 6);
  assert.equal(l.labor.total, 0);
  assert.equal(l.labor.none, true, "nothing priced: the $ is missing, not $0");
  assert.deepEqual(l.labor.notCounted, ["No Rate: no hourly rate (6.0h)"]);
  assert.ok(l.notes[0].includes("No Rate"), "and is named as left out of the average");
});

test("someone with pay type not set: in total hours, not in hourly labor, and said so", () => {
  const l = scheduleLabor(input({
    people: withPeople({ id: "unset", name: "Unset Person", hourly_rate: 12, pay_type: null, active: true }),
    shifts: [shift("unset", "2030-10-14", "12:00", "16:00"), shift("ten", "2030-10-14", "16:00", "18:00")],
  }));
  assert.equal(l.totalHours, 6);
  assert.equal(l.hourlyHours, 2);
  close(l.labor.wages, 20);
  assert.ok(l.labor.notCounted.includes("Unset Person: pay type not set on the Team page (4.0h, not in hourly labor)"));
});

test("a shift held by someone no longer active still costs at their rate", () => {
  const l = scheduleLabor(input({
    people: withPeople({ id: "gone", name: "Gone Hourly", hourly_rate: 12, pay_type: "hourly", active: false }),
    shifts: [shift("gone", "2030-10-14", "12:00", "17:00")],
  }));
  close(l.labor.wages, 60);
});

test("shifts on the padding days either side of the week are not counted", () => {
  const l = scheduleLabor(input({ shifts: [shift("ten", "2030-10-12", "12:00", "20:00"), shift("ten", "2030-10-20", "12:00", "20:00")] }));
  assert.equal(l.totalHours, 0);
  assert.equal(l.labor.total, 0);
  assert.equal(l.labor.none, false, "nothing to price is a real $0");
});
