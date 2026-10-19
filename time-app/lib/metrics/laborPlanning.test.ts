// Labor Hours Planning (bj-finance #742), pinned with round invented figures
// so each expectation can be checked by hand. crm-app is public: nothing here
// is a real sale, rate, hour count or event.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { trendFactor, type MonthlySalesRow } from "../controlBoard/math.ts";
import type { SettingRow } from "../controlBoard/settings.ts";
import type { LaborPerson, LaborShift } from "../controlBoard/schedule.ts";
import type { StoreHoursRow } from "../coverage.ts";
import { addDays, eachDay } from "./dates.ts";
import {
  PLANNING_WEEKS,
  eventsInForce,
  isMarketingEventType,
  lastYearHours,
  laborHoursPlanning,
  marketingDealsFrom,
  planningWindow,
  planningWeekCount,
  type LaborPlanningInputs,
  type MarketingDeal,
} from "./laborPlanning.ts";

const close = (a: number | null | undefined, b: number, msg?: string) => {
  assert.ok(a != null, msg ?? `expected ${b}, got null`);
  assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} expected ${b}, got ${a}`);
};

// Today is Wednesday 2030-10-16; its week starts Sunday 2030-10-13. October in
// New York is UTC-4.
const TODAY = "2030-10-16";
const WEEK = "2030-10-13";
const ny = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCHours(h + 4, m);
  return d.toISOString();
};

let nextId = 1;
const row = (key: string, value: number, detail: SettingRow["detail"] = {}, effective_from = "2030-01-01"): SettingRow => ({
  id: nextId++, key, value, detail, effective_from, review_by: "2031-12-31", source: "invented", method: null, recorded_by: null, recorded_at: `${effective_from}T00:00:00Z`,
});

// Sales 800,000 + 200,000; payroll 25%; taxes and comp add 25% to wages.
// Nobody salaried: 250,000 / 1.25 = 200,000 of hourly wages, an hourly goal of 20%.
const BOARD: SettingRow[] = [
  row("sales_estimate.in_store", 800_000),
  row("sales_estimate.catering", 200_000),
  row("target.payroll_pct", 0.25),
  row("tax.fica", 0.15, { wage_cap: null }),
  row("tax.futa", 0.05, { wage_cap: null }),
  row("tax.pa_uc", 0.04, { wage_cap: null }),
  row("tax.workers_comp", 1),
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

/** Open 10:00 to 21:00 every day: 11 hours. */
const everyDay = (opens = "10:00:00", closes = "21:00:00", effective_from?: string): StoreHoursRow[] =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_closed: false, opens, closes, ...(effective_from ? { effective_from } : {}) }));

/** Last year's in-store sales: 1,000 on every day from a year and a half back to yesterday, except `skip`. */
function sales(skip: string[] = [], override: Record<string, number> = {}) {
  return eachDay(addDays(TODAY, -560), addDays(TODAY, -1))
    .filter((d) => !skip.includes(d))
    .map((day) => ({ day, in_store: override[day] ?? 1_000 }));
}

/** Last year's catering (or marketing) hours: zero on every day of the year before today, plus `hours`. */
function history(hours: Record<string, number> = {}) {
  return eachDay(addDays(TODAY, -400), addDays(TODAY, -1)).map((day) => ({ day, hours: hours[day] ?? 0 }));
}

let shiftId = 1;
const cateringShift = (deal_id: number | null, day: string, from: string, to: string, position = "Catering"): LaborShift => ({
  id: shiftId++, employee_id: "ten", starts_at: ny(day, from), ends_at: ny(day, to), position, deal_id,
});
const marketingShift = (deal_id: number | null, day: string, from: string, to: string) => cateringShift(deal_id, day, from, to, "Marketing");

/** A marketing deal: counted (any stage but Closed Lost, not archived) unless `counts` is false. */
const mDeal = (id: number, day: string, billedHours: number | null, counts = true): MarketingDeal => ({ id, day, billedHours, counts });

function inputs(over: Partial<LaborPlanningInputs> = {}): LaborPlanningInputs {
  return {
    today: TODAY,
    settings: BOARD,
    salaries: [],
    salaried: [],
    trend: trendFactor(TODAY, MONTHLY, []),
    people: PEOPLE,
    sales: sales(),
    storeHours: everyDay(),
    exceptions: [],
    closedRanges: [],
    bookings: [],
    marketingDeals: [],
    shifts: [],
    cateringHistory: history(),
    marketingHistory: history(),
    concessionEvents: [],
    ...over,
  };
}

const first = (over: Partial<LaborPlanningInputs> = {}) => laborHoursPlanning(inputs(over)).weeks[0];

// ---------------------------------------------------------------------------
// The weeks
// ---------------------------------------------------------------------------

test("52 Sunday-to-Saturday weeks from the one holding today; the slider shows 4 to 52, 26 by default", () => {
  const p = laborHoursPlanning(inputs());
  assert.equal(p.weeks.length, PLANNING_WEEKS.max);
  assert.equal(p.weeks[0].start, WEEK);
  assert.equal(p.weeks[0].end, "2030-10-19");
  assert.equal(p.weeks[51].start, "2031-10-05");
  assert.equal(p.weeks[51].end, "2031-10-11");
  assert.deepEqual([PLANNING_WEEKS.min, PLANNING_WEEKS.default, PLANNING_WEEKS.max], [4, 26, 52]);
  assert.equal(planningWeekCount(undefined), 26);
  assert.equal(planningWeekCount(2), 4);
  assert.equal(planningWeekCount(60), 52);
  assert.equal(planningWeekCount(13.4), 13);
});

// ---------------------------------------------------------------------------
// Affordable hours
// ---------------------------------------------------------------------------

test("affordable hours = last year's same weekday x trend x the hourly goal / the average active hourly rate", () => {
  const w = first();
  // 1,000 x 1.1 = 1,100 a day; x 20% = 220; / 15 = 14.667 hours a day.
  close(w.projectedInStore, 7 * 1_100);
  close(w.affordableHours.value, (7 * 220) / 15);
  assert.equal(w.days[0].lastYearDay, "2029-10-14", "364 days earlier: the same weekday");
  close(laborHoursPlanning(inputs()).avgRate.value, 15, "salaried staff are not in the average");
});

test("a board value with a future effective date takes over from that date (boardOn)", () => {
  // From Wednesday the payroll target is 30%: 300,000 / 1.25 = 240,000, a 24% hourly goal.
  const w = first({ settings: [...BOARD, row("target.payroll_pct", 0.3, {}, "2030-10-16")] });
  close(w.days[2].hourlyGoal, 0.2, "Tuesday: the old goal");
  close(w.days[3].hourlyGoal, 0.24, "Wednesday: the new goal");
  close(w.affordableHours.value, (3 * 1_100 * 0.2 + 4 * 1_100 * 0.24) / 15);
  assert.equal(w.hourlyGoal.value, null, "the goal changed during the week, so the week has no single goal");
});

test("concession event net sales are spread evenly over the event's days and add to affordable hours", () => {
  const w = first({ concessionEvents: [{ name: "Expo", start_date: "2030-10-14", end_date: "2030-10-16", expected_net_sales: 3_000 }] });
  close(w.days[1].concessionSales, 1_000);
  close(w.days[3].concessionSales, 1_000);
  close(w.days[4].concessionSales, 0);
  close(w.concessionSales, 3_000);
  close(w.affordableHours.value, (7 * 220 + 3_000 * 0.2) / 15);
  // Drawn as two bands: in-store hours and concession hours.
  close(w.inStoreHours.value, (7 * 220) / 15);
  close(w.concessionHours.value, (3_000 * 0.2) / 15);
  assert.deepEqual(w.events, ["Expo"]);
  // A placeholder event says so in the week's notes.
  const placeholder = first({ concessionEvents: [{ name: "Expo", start_date: "2030-10-14", end_date: "2030-10-14", expected_net_sales: 1, provisional: true }] });
  assert.deepEqual(placeholder.events, ["Expo (placeholder)"]);
  // An event running into the next week puts only its own days' share in each week.
  const p = laborHoursPlanning(inputs({ concessionEvents: [{ name: "Expo", start_date: "2030-10-18", end_date: "2030-10-21", expected_net_sales: 4_000 }] }));
  close(p.weeks[0].concessionSales, 2_000);
  close(p.weeks[1].concessionSales, 2_000);
});

test("a closed date projects no sales and needs no cover, even if it was open last year", () => {
  const w = first({
    exceptions: [{ date: "2030-10-15", label: "Holiday", is_closed: true, opens: null, closes: null }],
    closedRanges: [{ start_date: "2030-10-18", end_date: "2030-10-19", title: "Closed for works" }],
  });
  close(w.days[2].projectedInStore, 0);
  close(w.days[5].projectedInStore, 0);
  close(w.projectedInStore, 4 * 1_100);
  close(w.affordableHours.value, (4 * 220) / 15);
  close(w.coverageHours.value, 4 * 11);
  assert.deepEqual(w.closedDays, ["2030-10-15", "2030-10-18", "2030-10-19"]);
  // A concession event on a closed day still counts: it is not in the store.
  const withEvent = first({
    exceptions: [{ date: "2030-10-15", label: "Holiday", is_closed: true, opens: null, closes: null }],
    concessionEvents: [{ name: "Expo", start_date: "2030-10-15", end_date: "2030-10-15", expected_net_sales: 500 }],
  });
  close(withEvent.days[2].concessionSales, 500);
});

test("a missing last-year day is the average of the same weekday in the nearest weeks on each side with data, flagged filled", () => {
  // Wednesday's last-year day is 2029-10-17. It and the Wednesday after are
  // missing; the nearest Wednesdays with data are 2029-10-10 (800) and 2029-10-31 (1,400).
  const w = first({ sales: sales(["2029-10-17", "2029-10-24"], { "2029-10-10": 800, "2029-10-31": 1_400 }) });
  assert.equal(w.days[3].lastYearDay, "2029-10-17");
  assert.equal(w.days[3].filled, true);
  close(w.days[3].lastYearInStore, 1_100);
  close(w.days[3].projectedInStore, 1_210);
  assert.deepEqual(w.filledDays, ["2029-10-17"]);
  assert.equal(w.days[2].filled, false);
});

test("a missing last-year day with data on one side only takes that side; with none it is not available", () => {
  // The last week's last-year days end the Saturday before this week. Take its
  // Friday and Saturday off: the same weekdays a week later are not on file
  // yet, so only the weeks before can fill them.
  const recent = sales(["2030-10-11", "2030-10-12"]);
  const p = laborHoursPlanning(inputs({ sales: recent }));
  const last = p.weeks[51];
  const filled = last.days.filter((d) => d.filled);
  assert.deepEqual(filled.map((d) => d.lastYearDay), ["2030-10-11", "2030-10-12"]);
  for (const d of filled) close(d.lastYearInStore, 1_000);

  const none = first({ sales: [] });
  assert.equal(none.affordableHours.value, null);
  assert.ok(none.affordableHours.needs.some((n) => n.includes("in-store sales")), none.affordableHours.needs.join("; "));
});

test("affordable hours are not available without the board, a trend or an hourly rate, and say why", () => {
  assert.equal(first({ settings: [] }).affordableHours.value, null);
  assert.equal(first({ trend: trendFactor(TODAY, [], []) }).affordableHours.value, null);
  const noRate = first({ people: [PEOPLE[2]] });
  assert.equal(noRate.affordableHours.value, null);
  assert.ok(noRate.affordableHours.needs.some((n) => n.includes("hourly")));
});

// ---------------------------------------------------------------------------
// Catering: booked, and the estimate still to come
// ---------------------------------------------------------------------------

test("booked hours: a booked deal's Catering shifts, or its labor_hours x staff_count when it has none yet", () => {
  const w = first({
    bookings: [
      { id: 1, day: "2030-10-15", billedHours: 6 },
      { id: 2, day: "2030-10-17", billedHours: 10 },
    ],
    shifts: [cateringShift(2, "2030-10-17", "10:00", "13:00"), cateringShift(2, "2030-10-17", "10:00", "14:00"), cateringShift(9, "2030-10-17", "10:00", "20:00")],
  });
  // Deal 1: no shifts, billed 6. Deal 2: shifts of 3 and 4 hours. Deal 9 is not booked.
  close(w.bookedHours, 6 + 7);
});

test("a booked deal with neither shifts nor billed crew hours counts nothing and is named", () => {
  const w = first({ bookings: [{ id: 4, day: "2030-10-15", billedHours: null }, { id: 5, day: "2030-10-16", billedHours: 0 }] });
  close(w.bookedHours, 0);
  assert.ok(w.notes.some((n) => n.includes("#4")), w.notes.join("; "));
  assert.ok(!w.notes.some((n) => n.includes("#5")), "billed zero crew hours is a real zero (a pickup)");
});

test("the three bands: estimated = max(last year's catering hours that week - booked, 0)", () => {
  // Last year's week (2029-10-14..20) had 20 catering hours.
  const hist = history({ "2029-10-16": 20 });
  const some = first({ cateringHistory: hist, bookings: [{ id: 1, day: "2030-10-15", billedHours: 6 }, { id: 2, day: "2030-10-17", billedHours: 7 }] });
  close(some.lastYearCatering, 20);
  close(some.bookedHours, 13);
  close(some.estimatedHours.value, 7, "booking converts estimated hours into booked hours");
  close(some.bookedHours + some.estimatedHours.value!, 20, "the catering bars stay at last year's until booked passes it");

  const more = first({ cateringHistory: hist, bookings: [{ id: 1, day: "2030-10-15", billedHours: 26 }] });
  close(more.estimatedHours.value, 0, "never below zero");
  close(more.bookedHours, 26, "the bar grows once booked passes the estimate");

  const none = first({ cateringHistory: hist });
  close(none.estimatedHours.value, 20);
  close(none.bookedHours, 0);
});

test("the estimate is not available when last year's catering hours are not on file for the week", () => {
  const w = first({ cateringHistory: null });
  assert.equal(w.estimatedHours.value, null);
  const gap = first({ cateringHistory: history().filter((r) => r.day !== "2029-10-16") });
  assert.equal(gap.estimatedHours.value, null);
  assert.ok(gap.estimatedHours.needs.some((n) => n.includes("catering")), gap.estimatedHours.needs.join("; "));
});

// ---------------------------------------------------------------------------
// Marketing: booked, and the estimate still to come
// ---------------------------------------------------------------------------

test("a marketing deal is one whose event type starts with Marketing, counted at any stage but Closed Lost, never archived", () => {
  assert.equal(isMarketingEventType("Marketing Event"), true);
  assert.equal(isMarketingEventType("Marketing / Tabling"), true);
  assert.equal(isMarketingEventType(" Marketing Event - Tabletop Comp"), true);
  assert.equal(isMarketingEventType("Birthday Party"), false);
  assert.equal(isMarketingEventType(null), false);
  const row = (id: number, event_type: string | null, stage: string, archived = 0, more: Record<string, unknown> = {}) => ({
    id, event_type, stage, archived, event_date: "2030-10-15", labor_hours: 3, staff_count: 2, ...more,
  });
  const deals = marketingDealsFrom([
    row(1, "Marketing Event", "Closed Marketing Event"),
    row(2, "Marketing Event", "Closed Lost"),
    row(3, "Marketing Event", "Booked Paid", 1),
    row(4, "Corporate", "Booked Paid"),
    row(5, "Marketing / Tabling", "Event Complete", 0, { labor_hours: null }),
  ]);
  assert.deepEqual(deals, [
    { id: 1, day: "2030-10-15", billedHours: 6, counts: true },
    { id: 2, day: "2030-10-15", billedHours: 6, counts: false },
    { id: 3, day: "2030-10-15", billedHours: 6, counts: false },
    { id: 5, day: "2030-10-15", billedHours: null, counts: true },
  ]);
});

test("marketing booked hours: a marketing deal's shifts of any position, or its labor hours x staff count; plus every other Marketing shift", () => {
  const w = first({
    marketingDeals: [mDeal(1, "2030-10-15", 6), mDeal(2, "2030-10-17", 10), mDeal(3, "2030-10-18", 4, false)],
    shifts: [
      cateringShift(2, "2030-10-17", "10:00", "13:00"),
      marketingShift(2, "2030-10-17", "10:00", "12:00"),
      marketingShift(null, "2030-10-18", "09:00", "14:00"),
      marketingShift(3, "2030-10-18", "09:00", "10:00"),
      marketingShift(50, "2030-10-18", "09:00", "19:00"),
    ],
  });
  // Deal 1: no shifts, billed 6. Deal 2: shifts of 3 and 2 hours. A Marketing
  // shift with no deal: 5. A Marketing shift on deal 50, not a marketing deal:
  // 10. Deal 3 is Closed Lost, so its shift counts nowhere.
  close(w.marketingBookedHours, 6 + 5 + 5 + 10);
  close(w.bookedHours, 0, "none of it is catering");
});

test("marketing deals and their shifts leave catering booked, even when the deal reads as booked", () => {
  const w = first({
    bookings: [{ id: 1, day: "2030-10-15", billedHours: 6 }, { id: 2, day: "2030-10-16", billedHours: 8 }],
    marketingDeals: [mDeal(2, "2030-10-16", 8)],
    shifts: [cateringShift(2, "2030-10-16", "10:00", "14:00")],
  });
  close(w.bookedHours, 6);
  close(w.marketingBookedHours, 4);
});

test("a marketing deal with neither shifts nor labor hours counts nothing and is named", () => {
  const w = first({ marketingDeals: [mDeal(7, "2030-10-15", null)] });
  close(w.marketingBookedHours, 0);
  assert.ok(w.notes.some((n) => n.includes("#7")), w.notes.join("; "));
});

test("marketing estimated = max(last year's marketing hours that week - marketing booked, 0)", () => {
  const hist = history({ "2029-10-16": 30 });
  const some = first({ marketingHistory: hist, marketingDeals: [mDeal(1, "2030-10-16", 12)] });
  close(some.lastYearMarketing, 30);
  close(some.marketingBookedHours, 12);
  close(some.marketingEstimatedHours.value, 18);
  const more = first({ marketingHistory: hist, marketingDeals: [mDeal(1, "2030-10-16", 40)] });
  close(more.marketingEstimatedHours.value, 0, "never below zero");
  const none = first({ marketingHistory: hist });
  close(none.marketingEstimatedHours.value, 30);
  close(none.estimatedHours.value, 0, "last year's marketing is not catering");
  assert.equal(first({ marketingHistory: null }).marketingEstimatedHours.value, null);
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

test("coverage hours = the store hours of the season in force, one person, summed over the week", () => {
  close(first().coverageHours.value, 7 * 11);
  // A shorter season from Wednesday: 13:00 to 21:00, 8 hours.
  const w = first({ storeHours: [...everyDay(), ...everyDay("13:00:00", "21:00:00", "2030-10-16")] });
  close(w.days[2].coverageHours, 11, "Tuesday: the standing hours");
  close(w.days[3].coverageHours, 8, "Wednesday: the season");
  close(w.coverageHours.value, 3 * 11 + 4 * 8);
  assert.equal(first({ storeHours: [] }).coverageHours.value, null, "hours never set are not zero");
});

// ---------------------------------------------------------------------------
// Last year's catering hours: the loaded history, then the CRM's shifts
// ---------------------------------------------------------------------------

test("last year's hours: the loaded days, then the CRM's shifts, with concession event days and marketing taken out of catering as they are read", () => {
  // Loaded from When I Work: raw Catering hours, one day marked marketing (the
  // archive has no other marker), one day a concession event's.
  const loaded = [
    { day: "2030-06-27", hours: 4 },
    { day: "2030-06-28", hours: 50, kind: "marketing" as const },
    { day: "2030-06-29", hours: 9 },
    { day: "2030-06-30", hours: 0 },
  ];
  const s = (deal_id: number | null, position: string, day: string, from: string, to: string) => ({ starts_at: ny(day, from), ends_at: ny(day, to), position, deal_id });
  const shifts = [
    s(null, "Catering", "2030-07-01", "10:00", "15:00"),
    s(8, "Catering", "2030-07-01", "12:00", "14:00"),
    s(20, "Catering", "2030-07-02", "10:00", "13:00"), // a marketing deal crewed under Catering
    s(21, "Marketing", "2030-07-02", "10:00", "12:00"),
    s(null, "Marketing", "2030-07-02", "15:00", "16:00"),
    s(22, "Catering", "2030-07-02", "09:00", "10:00"), // a Closed Lost marketing deal: in neither
    s(8, "Marketing", "2030-07-02", "09:00", "19:00"), // a Marketing shift on a catering deal: marketing (its position says so)
    s(null, "PENN Opener", "2030-07-02", "09:00", "19:00"),
    s(null, "Catering", "2030-07-03", "09:00", "17:00"),
    s(null, "Catering", "2030-06-30", "09:00", "19:00"), // a loaded day: the loaded row stands
  ];
  const h = lastYearHours({
    loaded,
    shifts,
    marketingDeals: [mDeal(20, "2030-07-02", null), mDeal(21, "2030-07-02", null), mDeal(22, "2030-07-02", null, false)],
    concessionEvents: [
      { name: "Expo", start_date: "2030-07-03", end_date: "2030-07-03", expected_net_sales: 1 },
      { name: "Fair", start_date: "2030-06-29", end_date: "2030-06-29", expected_net_sales: 1 },
    ],
    through: "2030-07-04",
  });
  assert.deepEqual(h.catering, [
    { day: "2030-06-27", hours: 4 },
    { day: "2030-06-28", hours: 0 },
    { day: "2030-06-29", hours: 0 },
    { day: "2030-06-30", hours: 0 },
    { day: "2030-07-01", hours: 7 },
    { day: "2030-07-02", hours: 0 },
    { day: "2030-07-03", hours: 0 },
    { day: "2030-07-04", hours: 0 },
  ]);
  assert.deepEqual(h.marketing, [
    { day: "2030-06-27", hours: 0 },
    { day: "2030-06-28", hours: 50 },
    { day: "2030-06-29", hours: 0 },
    { day: "2030-06-30", hours: 0 },
    { day: "2030-07-01", hours: 0 },
    { day: "2030-07-02", hours: 16 },
    { day: "2030-07-03", hours: 0 },
    { day: "2030-07-04", hours: 0 },
  ]);
  // An event added later takes its days out at once: nothing is reloaded.
  const later = lastYearHours({ loaded, shifts, marketingDeals: [], concessionEvents: [{ name: "Show", start_date: "2030-06-27", end_date: "2030-07-01", expected_net_sales: 1 }], through: "2030-07-01" });
  assert.deepEqual(later.catering.map((r) => r.hours), [0, 0, 0, 0, 0]);
  assert.deepEqual(later.marketing.map((r) => r.hours), [0, 50, 0, 0, 0], "a concession event does not touch marketing");
});

// ---------------------------------------------------------------------------
// Events as board values, and the days the card reads
// ---------------------------------------------------------------------------

test("events: the revision in force today per event, cancelled ones dropped", () => {
  const rev = (id: number, event_key: string, effective_from: string, more: Record<string, unknown> = {}) => ({
    id, event_key, effective_from, recorded_at: `${effective_from}T00:00:00Z`, cancelled: false, name: event_key, ...more,
  });
  const rows = [
    rev(1, "expo", "2030-09-01", { start_date: "2031-01-10" }),
    rev(2, "expo", "2030-10-01", { start_date: "2031-01-17" }),
    rev(3, "expo", "2030-11-01", { start_date: "2031-01-24" }),
    rev(4, "fair", "2030-09-01"),
    rev(5, "fair", "2030-10-02", { cancelled: true }),
  ];
  const now = eventsInForce(rows, TODAY);
  assert.deepEqual(now.map((r) => r.id), [2], "the latest revision on or before today; a cancelled one takes the event off");
  assert.deepEqual(eventsInForce(rows, "2030-09-15").map((r) => r.id), [1, 4]);
});

test("the days the card reads: last year's from a year before this week, with room either side to fill gaps", () => {
  const w = planningWindow(TODAY);
  assert.equal(w.firstWeek, WEEK);
  // 52 weeks: Sunday 2030-10-13 to Saturday 2031-10-11. Last year's days are
  // the same weekdays 52 weeks earlier: Sunday 2029-10-14 to Saturday 2030-10-12.
  assert.equal(w.lastDay, "2031-10-11");
  assert.equal(w.lastYearFrom, "2029-10-14");
  assert.equal(w.lastYearTo, "2030-10-12");
  assert.ok(w.salesFrom < w.lastYearFrom && w.salesTo >= w.lastYearTo);
});
