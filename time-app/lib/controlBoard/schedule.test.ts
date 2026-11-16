// The Schedule page's labor line and day headers (bj-finance #695), pinned
// as the manager reads them. Round invented figures so each expectation can
// be checked by hand; crm-app is public, so nothing here is a real rate,
// salary or sale.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { trendFactor, type Derived, type MonthlySalesRow } from "./math.ts";
import { addDays, isMarketingDeal, MISSING, scheduleLabor, workKind, type LaborPerson, type LaborShift, type ScheduleLaborInput } from "./schedule.ts";
import { laborVsTarget, type LaborDayRow } from "../metrics/laborTarget.ts";
import type { SalaryRow, SettingRow } from "./settings.ts";

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
    inStoreByName: new Map([["Scooper", true], ["Catering", false], ["Marketing", false], ["Meeting", false]]),
    settings: BOARD,
    salaries: [] as SalaryRow[],
    salaried: [],
    trend: trendFactor(TODAY, MONTHLY, []),
    inStoreByDay: lastYear(),
    marketingDeals: new Set(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Day headers: all scheduled hours / that day's target hours
// ---------------------------------------------------------------------------

test("a day's target is last year's same weekday x trend, x the hourly goal, / the average active hourly rate: in-store only", () => {
  const l = scheduleLabor(input());
  const sun = l.days[0];
  assert.equal(sun.lastYearDay, "2029-10-14", "52 weeks earlier: the same weekday");
  close(val(sun.trendedInStore), 1_100);
  close(val(sun.projectedSales), 1_100);
  close(val(sun.hourlyGoal), 0.2);
  close(val(sun.targetDollars), 220);
  close(val(sun.targetHours), 220 / 15);

  close(val(l.target.dollars), 220 * 7, "the week's target is the sum of its days");
  close(val(l.target.hours), (220 * 7) / 15);
  assert.equal(l.boardEmpty, false);
});

test("projected sales and the target are in-store only: catering on the day never adds to them", () => {
  const l = scheduleLabor(input({ shifts: [{ ...shift("ten", "2030-10-14", "10:00", "15:00", "Catering"), deal_id: 7 }] }));
  close(val(l.days[1].projectedSales), 1_100, "1,000 x 1.1, whatever the deal is worth");
  close(val(l.days[1].targetDollars), 220);
  close(val(l.days[1].targetHours), 220 / 15);
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

test("hourly labor $ is in-store hourly hours x rate, plus solo-close bonuses, plus open shifts at the average rate; salaried and catering left out", () => {
  const l = scheduleLabor(input({
    shifts: [
      shift("ten", "2030-10-14", "12:00", "20:00"), // 8h x 10 = 80
      shift("twenty", "2030-10-15", "10:00", "15:00", "Catering"), // catering work: out of the line, premium and all
      shift("sal", "2030-10-15", "09:00", "17:00"), // salaried: in total hours only
      shift(null, "2030-10-16", "12:00", "16:00"), // open 4h x 15 = 60
    ],
  }));
  assert.equal(l.totalHours, 25, "every shift is in total hours");
  assert.equal(l.hourlyHours, 12, "the in-store hourly 8h and the open 4h");
  close(l.labor.wages, 80);
  close(l.labor.open, 60);
  close(l.labor.solo, 0, "no night here has a closer out at or after the cut-off");
  close(l.labor.total, 140);
  assert.deepEqual(l.workOff, { cateringHours: 5, marketingHours: 0 });
  assert.deepEqual(l.labor.notCounted, []);
  assert.equal(l.labor.none, false);
});

test("solo close: the last in-store closer alone the board's hours or more, out at or after its cut-off, earns the board's bonus", () => {
  const night = "2030-10-17";
  const l = scheduleLabor(input({
    shifts: [
      shift("twenty", night, "12:00", "18:00"),
      shift("ten", night, "17:00", "22:30"), // alone 18:00-22:30 = 4.5h, out 22:30
      shift("twenty", night, "20:00", "23:30", "Catering"), // catering work: does not close
      { ...shift("twenty", night, "21:00", "23:45"), deal_id: 9 }, // a store position on a marketing deal: marketing work, does not close
    ],
    marketingDeals: new Set([9]),
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

test("with no solo-close rule on the board, the $ shows what it has and says what it left out; a missing catering premium is not a gap, catering is out", () => {
  const settings = BOARD.filter((r) => !r.key.startsWith("rule."));
  const l = scheduleLabor(input({
    settings,
    shifts: [shift("ten", "2030-10-14", "12:00", "20:00"), shift("ten", "2030-10-15", "10:00", "12:00", "Catering")],
  }));
  close(l.labor.total, 80);
  assert.deepEqual(l.labor.notCounted, [MISSING.solo]);
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

// ---------------------------------------------------------------------------
// Catering and marketing work (Alina, 2026-11-16): out of the line, the way
// the Labor vs target card takes them out, never offset by a deal's quote
// ---------------------------------------------------------------------------

const MON = "2030-10-14";
const onDeal = (s: LaborShift, dealId: number): LaborShift => ({ ...s, deal_id: dealId });
const inStoreMon = 220; // 1,000 x 1.1 x 20%

test("a shift's work: Marketing by position or any shift on a marketing deal, else Catering by position, else in-store", () => {
  const mkt = new Set([9]);
  assert.equal(workKind(shift("ten", MON, "10:00", "12:00", "Marketing"), mkt), "marketing");
  assert.equal(workKind(shift("ten", MON, "10:00", "12:00", " marketing "), mkt), "marketing", "read as bj-finance reads it: trimmed, any case");
  assert.equal(workKind(onDeal(shift("ten", MON, "10:00", "12:00", "Catering"), 9), mkt), "marketing", "a marketing deal's Catering shift is never catering");
  assert.equal(workKind(onDeal(shift("ten", MON, "10:00", "12:00", "Scooper"), 9), mkt), "marketing");
  assert.equal(workKind(onDeal(shift("ten", MON, "10:00", "12:00", "Marketing"), 7), mkt), "marketing", "a Marketing shift on a catering deal");
  assert.equal(workKind(onDeal(shift("ten", MON, "10:00", "12:00", "Catering"), 7), mkt), "catering");
  assert.equal(workKind(shift("ten", MON, "10:00", "12:00", "catering"), mkt), "catering");
  assert.equal(workKind(onDeal(shift("ten", MON, "10:00", "12:00", "Scooper"), 7), mkt), null, "a store shift on a catering deal is in-store");
  assert.equal(workKind(shift("ten", MON, "10:00", "12:00", null), mkt), null);
});

test("a marketing deal: event type starting Marketing, or stage Closed Marketing Event", () => {
  assert.equal(isMarketingDeal({ event_type: "Marketing Event", stage: "Event Complete" }), true);
  assert.equal(isMarketingDeal({ event_type: "  marketing - tabling", stage: "Booked Paid" }), true);
  assert.equal(isMarketingDeal({ event_type: "Birthday Party", stage: "Closed Marketing Event" }), true);
  assert.equal(isMarketingDeal({ event_type: "Birthday Party", stage: "Event Complete" }), false);
  assert.equal(isMarketingDeal({ event_type: "Corporate (marketing budget)", stage: "Event Complete" }), false, "the event type must start with Marketing, not merely mention it");
  assert.equal(isMarketingDeal({ event_type: null, stage: null }), false);
});

test("catering and marketing shifts leave the scheduled side, hours and $, and the target does not grow for them", () => {
  const base = scheduleLabor(input({ shifts: [shift("ten", MON, "12:00", "18:00")] }));
  const l = scheduleLabor(input({
    marketingDeals: new Set([9]),
    shifts: [
      shift("ten", MON, "12:00", "18:00"), // in-store: 6h x 10
      onDeal(shift("twenty", MON, "10:00", "15:00", "Catering"), 7), // catering 5h
      onDeal(shift(null, MON, "10:00", "15:00", "Catering"), 7), // open catering 5h
      shift("twenty", "2030-10-15", "10:00", "13:00", "Marketing"), // marketing 3h, no deal
      onDeal(shift("ten", "2030-10-16", "10:00", "14:00", "Scooper"), 9), // marketing deal 4h
    ],
  }));
  assert.equal(l.hourlyHours, base.hourlyHours);
  close(l.labor.total, base.labor.total, "$ alike: no wages, no premium, no open-shift $ for the work taken out");
  close(val(l.target.dollars)!, val(base.target.dollars)!);
  close(val(l.target.hours)!, val(base.target.hours)!);
  assert.deepEqual(l.workOff, { cateringHours: 10, marketingHours: 7 });
  assert.equal(l.totalHours, 6 + 5 + 5 + 3 + 4, "still in total hours");
  assert.equal(l.days[1].scheduledHours, 16, "and in the day header");
});

test("a catering deal with nobody scheduled takes nothing off and adds nothing: the line never reads a quote", () => {
  const l = scheduleLabor(input());
  close(val(l.days[1].targetDollars), inStoreMon);
  assert.deepEqual(l.workOff, { cateringHours: 0, marketingHours: 0 });
});

test("catering work by someone with no rate or no pay type is out of the line, not listed as a gap", () => {
  const l = scheduleLabor(input({
    people: withPeople(
      { id: "norate", name: "No Rate", hourly_rate: null, pay_type: "hourly", active: true },
      { id: "unset", name: "Unset Person", hourly_rate: 12, pay_type: null, active: true },
    ),
    shifts: [shift("norate", MON, "10:00", "14:00", "Catering"), shift("unset", MON, "10:00", "14:00", "Marketing")],
  }));
  assert.equal(l.hourlyHours, 0);
  assert.deepEqual(l.labor.notCounted, []);
  assert.equal(l.labor.none, false, "nothing in the line to price is a real $0");
  assert.deepEqual(l.workOff, { cateringHours: 4, marketingHours: 0 }, "the hourly person's 4h; pay type not set was never hourly labor");
});

test("salaried and overhead staff on catering or marketing work stay out, as everywhere else, and are not counted as taken off", () => {
  const l = scheduleLabor(input({
    people: withPeople({ id: "ovh", name: "Over Head", hourly_rate: 40, pay_type: "hourly", active: true, overhead: true }),
    shifts: [shift("ovh", MON, "10:00", "14:00", "Catering"), shift("sal", MON, "10:00", "14:00", "Marketing")],
  }));
  close(l.labor.total, 0);
  assert.equal(l.hourlyHours, 0);
  assert.deepEqual(l.workOff, { cateringHours: 0, marketingHours: 0 });
});

test("a past week worked exactly as scheduled reads the same on the line as on the Labor vs target card", () => {
  // Sun-Sat 2030-10-13..19. Each day: ten 12:00-17:00 in-store (5h x 10 = 50),
  // twenty 17:00-22:30 in-store (5.5h x 20 = 110, alone 4.5h out 22:30: solo 30).
  // Monday also: twenty 10:00-14:00 Catering (4h x 20 = 80, premium 1/h = 4),
  // ten 09:00-12:00 Marketing (3h x 10 = 30). Sales as projected: 1,100 a day.
  const shifts: LaborShift[] = [];
  for (const d of DATES) shifts.push(shift("ten", d, "12:00", "17:00"), shift("twenty", d, "17:00", "22:30"));
  shifts.push(onDeal(shift("twenty", MON, "10:00", "14:00", "Catering"), 7), shift("ten", MON, "09:00", "12:00", "Marketing"));
  const line = scheduleLabor(input({ shifts }));
  close(line.labor.total, 7 * (50 + 110 + 30), "in-store wages and solo close only: 1,330");
  assert.equal(line.hourlyHours, 7 * 10.5);
  close(val(line.target.dollars)!, 7 * 220, "1,100 x 20% a day");

  // The same week as the card reads it, paid exactly at those rates.
  const labor: LaborDayRow[] = DATES.map((day) => {
    const mon = day === MON;
    return {
      day, hours: 10.5 + (mon ? 7 : 0), wages: 160 + (mon ? 110 : 0), catering_premium: mon ? 4 : 0, solo_close: 30,
      catering_hours: mon ? 4 : 0, catering_wages: mon ? 80 : 0, marketing_hours: mon ? 3 : 0, marketing_wages: mon ? 30 : 0,
    };
  });
  const [card] = laborVsTarget([WEEK], {
    today: "2030-10-25", labor, sales: DATES.map((day) => ({ day, in_store: 1_100 })), settings: BOARD, salaries: [], salaried: [],
  });
  assert.ok(card.available, card.why.join("; "));
  close(card.actual!, line.labor.total * 1.25, "the card's actual is the line's $ plus 25% taxes and comp");
  close(card.targetDollars!, val(line.target.dollars)! * 1.25, "the card's all-in target is the line's target plus the same 25%");
  close(card.actualPct!, line.labor.total / (7 * 1_100) * 1.25, "so the same labor %, all-in");
  close(card.hours! - card.cateringHours! - card.marketingHours!, line.hourlyHours, "and the same in-store hours");
});

// ---------------------------------------------------------------------------
// Overhead staff (profiles.is_overhead, migration 45; bj-finance #692):
// not part of the payroll target, still on the schedule
// ---------------------------------------------------------------------------

// Hourly at 40, flagged overhead. Without the flag the average would be (10 + 20 + 40) / 3.
const OVERHEAD: LaborPerson = { id: "ovh", name: "Over Head", hourly_rate: 40, pay_type: "hourly", active: true, overhead: true };

test("an overhead hourly person is out of hourly labor hours and $, but in total hours and the day header", () => {
  const l = scheduleLabor(input({
    people: withPeople(OVERHEAD),
    shifts: [
      shift("ten", "2030-10-14", "12:00", "18:00"), // 6h x 10 = 60
      shift("ovh", "2030-10-14", "12:00", "18:00"), // overhead: total hours only
      shift("ovh", "2030-10-15", "10:00", "14:00", "Catering"), // overhead: no wages
      shift(null, "2030-10-16", "12:00", "16:00"), // open 4h x 15 = 60
    ],
  }));
  assert.equal(l.totalHours, 20);
  assert.equal(l.days[1].scheduledHours, 12, "the day header counts the overhead person's hours");
  assert.equal(l.hourlyHours, 10, "the hourly person's 6h and the open 4h");
  close(l.labor.wages, 60);
  close(l.labor.open, 60, "open shifts at the average without the overhead rate");
  close(l.labor.total, 120);
  assert.deepEqual(l.labor.notCounted, [], "overhead is not a gap to report");
});

test("the average active hourly rate, and so target hours, leave overhead staff out", () => {
  const without = scheduleLabor(input());
  const withOverhead = scheduleLabor(input({ people: withPeople(OVERHEAD) }));
  close(val(withOverhead.avgRate), 15);
  assert.equal(withOverhead.avgRateOver, 2);
  close(val(withOverhead.days[0].targetHours), val(without.days[0].targetHours) as number, "target hours do not move");
});

test("an overhead closer does not earn the solo-close bonus in hourly labor", () => {
  const night = "2030-10-17";
  const l = scheduleLabor(input({ people: withPeople(OVERHEAD), shifts: [shift("ovh", night, "17:00", "23:00")] }));
  close(l.labor.solo, 0);
  assert.equal(l.totalHours, 6);
});

test("an overhead person with no pay type set is left out quietly, not listed as missing a pay type", () => {
  const l = scheduleLabor(input({
    people: withPeople({ ...OVERHEAD, pay_type: null }),
    shifts: [shift("ovh", "2030-10-14", "12:00", "18:00")],
  }));
  assert.equal(l.hourlyHours, 0);
  assert.deepEqual(l.labor.notCounted, []);
});

test("not overhead is unchanged: the same person without the flag is hourly labor and in the average", () => {
  const notOverhead = { ...OVERHEAD, overhead: false };
  const l = scheduleLabor(input({ people: withPeople(notOverhead), shifts: [shift("ovh", "2030-10-14", "12:00", "18:00")] }));
  assert.equal(l.hourlyHours, 6);
  close(l.labor.wages, 240);
  close(val(l.avgRate), 23.333333, "10, 20 and 40 average 23.33");
  const unset = scheduleLabor(input({ people: withPeople({ ...OVERHEAD, overhead: undefined }), shifts: [shift("ovh", "2030-10-14", "12:00", "18:00")] }));
  close(unset.labor.wages, 240, "no flag reads as not overhead");
});

// ---------------------------------------------------------------------------
// Past weeks (bj-finance #696 fix, 2026-10-16): a pay rule (rule.*) did not
// exist before its first row, so on those days it costs nothing; a key with
// no rows at all is still missing.
// ---------------------------------------------------------------------------

const THU = "2030-10-17";
const lateRules = () => [
  ...BOARD.filter((r) => !r.key.startsWith("rule.")),
  row("rule.solo_close", 30, { min_alone_hours: 4, out_at_or_after: "22:00" }, THU),
];

test("before a pay rule's first row the rule did not exist: no solo-close bonus, and nothing listed as not counted", () => {
  const l = scheduleLabor(input({ settings: lateRules(), shifts: [shift("twenty", MON, "16:00", "23:00")] }));
  assert.deepEqual(l.labor.notCounted, []);
  close(l.labor.solo, 0, "Monday is before the solo-close rule's first row");
  close(l.labor.total, 7 * 20);
});

test("from a pay rule's first row on, it applies as before", () => {
  const l = scheduleLabor(input({ settings: lateRules(), shifts: [shift("twenty", THU, "16:00", "23:00")] }));
  assert.deepEqual(l.labor.notCounted, []);
  close(l.labor.solo, 30);
});

// ---------------------------------------------------------------------------
// Closed days (Thanksgiving 2026: the store closed 11-26 to 11-29)
// ---------------------------------------------------------------------------

test("a closed day has no in-store target, even when the store was open that day last year", () => {
  const l = scheduleLabor(input({ closedDays: new Set(["2030-10-15"]) }));
  const tue = l.days[2];
  assert.equal(tue.closed, true);
  close(val(tue.projectedSales), 0, "closed: nothing projected, whatever last year sold");
  close(val(tue.targetDollars), 0);
  close(val(tue.targetHours), 0);
  assert.equal(tue.short, null);
  close(val(l.target.dollars), 220 * 6, "the week's target is the six open days");
  assert.equal(l.days[1].closed, false);
});

test("a closed day with no last-year sales on file does not make the week's target missing", () => {
  const l = scheduleLabor(input({ inStoreByDay: lastYear(["2029-10-16"]), closedDays: new Set(["2030-10-15"]) }));
  close(val(l.days[2].targetHours), 0);
  assert.deepEqual(l.target.hours.needs, []);
  close(val(l.target.hours), (220 * 6) / 15);
});

test("catering crewed on a closed day leaves both sides alone: no target, and its shifts out of the scheduled side", () => {
  const l = scheduleLabor(input({ closedDays: new Set(["2030-10-14"]), shifts: [onDeal(shift("ten", "2030-10-14", "10:00", "20:00", "Catering"), 7)] }));
  close(val(l.days[1].projectedSales), 0);
  close(val(l.days[1].targetHours), 0);
  assert.equal(l.hourlyHours, 0);
  close(l.labor.total, 0);
});
