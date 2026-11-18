// The finance feed (bj-finance #671, migration 40): parsing what
// bj-finance modules/metrics_publish.py publishes, and the metrics built on it
// (weekly LER on Labor vs target's weeks, monthly LER, COGS %). LER leaves
// owner pay out; the card's switch adds it (Alina, 2026-11-18).
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { closedMonthTiles, feedSales, parseClosedMonth, parseDaily, weeklyLer } from "./feed.ts";
import type { SalesTargetRow } from "./targets.ts";
import type { LaborTargetWeek } from "./laborTarget.ts";

const daily = {
  schema: 1,
  kind: "daily",
  as_of: "2026-10-09",
  cash: { as_of: "2026-10-09", bank_balance: 23456.78, outstanding_cheques: 1200, on_hand: 22256.78, day_in: 2300, day_out: 900 },
  sales_by_day: [
    { date: "2026-09-28", in_store: 1000, delivery: 100, concessions: 0, basis: "booked" },
    { date: "2026-10-04", in_store: 2000, delivery: 50, concessions: 500, concessions_gross: 900, basis: "booked" },
    { date: "2026-10-05", in_store: 1500, delivery: 0, concessions: 0, basis: "in_transit" },
  ],
  wages_by_week: [{ week_start: "2026-09-28", wages: 2500, employer_tax: 224, salaried_wages: 1150 }],
  cogs_pct_trailing: 0.25,
  cogs_basis: "Jul-Sep 2026 closed months",
  forward_cash: { start: "2026-10-10", days: 14, opening_on_hand: 22256.78, lines: [{ date: "2026-10-15", direction: "out", category: "recurring", amount: 5500, label: "Rent" }] },
};

test("a daily snapshot parses; a payload of another schema or shape is refused, never read as zeros", () => {
  const d = parseDaily(daily);
  assert.equal(d?.as_of, "2026-10-09");
  assert.equal(d?.cash?.on_hand, 22256.78);
  assert.equal(d?.sales_by_day.length, 3);
  assert.equal(parseDaily({ ...daily, schema: 2 }), null);
  assert.equal(parseDaily({ ...daily, sales_by_day: "nope" }), null);
  assert.equal(parseDaily(null), null);
  // Optional parts may be null.
  assert.equal(parseDaily({ ...daily, cash: null, forward_cash: null, cogs_pct_trailing: null })?.cash, null);
});

test("feed sales by stream: in-store includes delivery; concessions on the target's basis (net unless the row says gross)", () => {
  const d = parseDaily(daily)!;
  const net = feedSales(d, []);
  assert.equal(net.in_store?.["2026-10-04"], 2050);
  assert.equal(net.in_store?.["2026-09-28"], 1100);
  assert.equal(net.concessions?.["2026-10-04"], 500);
  const grossRows: SalesTargetRow[] = [{ month: "2026-10-01", stream: "concessions", amount: 1, basis: "x", measure: "gross" }];
  const gross = feedSales(d, grossRows);
  assert.equal(gross.concessions?.["2026-10-04"], 900);
  // A gross basis with no gross figure falls back to nothing for that day, not to net.
  assert.equal(gross.concessions?.["2026-10-05"] ?? null, null);
  assert.equal(gross.concessions?.["2026-09-28"], 0); // September has no gross row: net
});

test("concessions null on every day means the stream is still waiting, not zero", () => {
  const d = parseDaily({ ...daily, sales_by_day: daily.sales_by_day.map((r) => ({ ...r, concessions: null, concessions_gross: null })) })!;
  const s = feedSales(d, []);
  assert.equal(s.concessions, undefined);
  assert.equal(s.in_store?.["2026-10-04"], 2050);
});

/** A Labor vs target week as weeklyLer reads it: its sales, all labor and the marketing taken off. */
function week(start: string, over: Partial<LaborTargetWeek> = {}): LaborTargetWeek {
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return {
    start, end: end.toISOString().slice(0, 10), available: true, why: [], sales: 5_500, inStoreSales: 4_500, deliverySales: 500, cateringSales: 500,
    hours: 80, hourlyHours: 75, hourly: 1_500, salaried: 500, cateringHours: 5, cateringCost: 150, marketingHours: 5, marketingOffset: 200,
    actual: 2_000, actualPct: 2_000 / 5_500, goalPct: { value: 0.25, needs: [] }, targetPct: { value: 0.25, needs: [] }, targetDollars: 1_375,
    varianceDollars: 625, varianceHours: 31.25, ...over,
  };
}

test("weekly LER: Labor vs target's sales plus feed concessions, x (1 - trailing COGS %), over its labor with marketing put back", () => {
  const d = parseDaily(daily)!;
  // Week of Sunday Oct 4: 5,500 + the feed's 500 of concessions that Sunday = 6,000; labor 2,000 + 200 of marketing.
  const [r] = weeklyLer([week("2026-10-04")], 0.25, d);
  assert.equal(r.week, "2026-10-04");
  assert.equal(r.sales, 6_000);
  assert.equal(r.grossProfit, 4_500); // x 0.75, an estimate
  assert.equal(r.labour, 2_200);
  assert.equal(r.ler, 2.05); // 4,500 / 2,200, owner pay left out
  assert.equal(r.withOwnerPay, 1.22); // 4,500 / (2,200 + 1,476)
  // The week before: Sep 28's concessions are 0, so the sales are the card's alone.
  const [before] = weeklyLer([week("2026-09-27", { sales: 4_400 })], 0.25, d);
  assert.equal(before.sales, 4_400);
  assert.equal(before.ler, 1.5); // 3,300 / 2,200
  assert.equal(before.withOwnerPay, 0.9); // 3,300 / 3,676
});

test("weekly LER without the feed counts no concessions; without the trailing COGS % it has sales but no LER", () => {
  const [noFeed] = weeklyLer([week("2026-10-04")], 0.25, null);
  assert.equal(noFeed.sales, 5_500);
  assert.equal(noFeed.ler, 1.88); // 4,125 / 2,200
  const [noCogs] = weeklyLer([week("2026-10-04")], null, parseDaily(daily));
  assert.equal(noCogs.sales, 6_000);
  assert.equal(noCogs.grossProfit, null);
  assert.equal(noCogs.labour, 2_200);
  assert.equal(noCogs.ler, null);
  assert.equal(noCogs.withOwnerPay, null);
});

test("weekly LER of a week Labor vs target cannot count is unknown, never zero", () => {
  const d = parseDaily(daily)!;
  const [noSales] = weeklyLer([week("2026-10-04", { available: false, sales: null })], 0.25, d);
  assert.equal(noSales.sales, null);
  assert.equal(noSales.grossProfit, null);
  assert.equal(noSales.ler, null);
  assert.equal(noSales.withOwnerPay, null);
  const [noLabor] = weeklyLer([week("2026-10-04", { available: false, actual: null })], 0.25, d);
  assert.equal(noLabor.grossProfit, 4_500);
  assert.equal(noLabor.labour, null);
  assert.equal(noLabor.ler, null);
  assert.equal(noLabor.withOwnerPay, null);
  // Marketing not yet split: the labor is not known either.
  const [unsplit] = weeklyLer([week("2026-10-04", { marketingOffset: null })], 0.25, d);
  assert.equal(unsplit.labour, null);
  assert.equal(unsplit.ler, null);
});

test("closed month: tiles from the month close, LER on wages + employer tax, and with owner pay at $6,396 a month", () => {
  const m = parseClosedMonth({
    schema: 1, kind: "closed_month", month: "2026-09", status: "final",
    revenue: 41234.56, revenue_by_stream: { in_store: 30000, delivery: 1500, catering: 9000, concessions: 0, other: 734.56 },
    cogs: 9100, gross_profit: 32134.56, wages: 15000, employer_tax: 1300, pre_tax_profit: -1760.16,
    rolling_12: { months: 12, revenue: 401234, pre_tax_profit: -12345, seller_months: 8 },
  })!;
  const t = closedMonthTiles(m);
  assert.equal(t.ler, 1.97); // 32,134.56 / 16,300
  assert.equal(t.lerWithOwnerPay, 1.42); // 32,134.56 / 22,696
  assert.equal(t.cogsPct, 0.221);
  assert.equal(t.preTaxPct, -0.043);
  assert.equal(parseClosedMonth({ schema: 1, kind: "closed_month", month: "Sept" }), null);
});
