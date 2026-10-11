// The finance feed (bj-finance #671, migration 40): parsing what
// bj-finance modules/metrics_publish.py publishes, and the metrics built on it
// (weekly LER paid and unpaid, monthly LER, COGS %, sales per scooper-hour).
// Written before the code.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { closedMonthTiles, feedSales, parseClosedMonth, parseDaily, weeklyLer } from "./feed.ts";
import type { SalesTargetRow } from "./targets.ts";

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

test("weekly LER: (week sales x (1 - trailing COGS %)) / (wages + employer tax + owner comp), paid and unpaid", () => {
  const d = parseDaily(daily)!;
  // Week of Sep 28: feed 1,100 + 2,550 = 3,650; catering 2,350 by event date: 6,000 sales.
  const rows = weeklyLer(d, { "2026-09-30": 2350 }, ["2026-09-28"]);
  assert.equal(rows[0].sales, 6000);
  assert.equal(rows[0].grossProfit, 4500); // x 0.75, an estimate
  assert.equal(rows[0].unpaid, 1.65); // 4,500 / 2,724
  assert.equal(rows[0].paid, 1.07); // 4,500 / 4,200
  // A week with no wages from the feed has no LER.
  const none = weeklyLer(d, {}, ["2026-10-05"]);
  assert.equal(none[0].paid, null);
  // No trailing COGS %: no LER either.
  const noCogs = weeklyLer({ ...d, cogs_pct_trailing: null }, {}, ["2026-09-28"]);
  assert.equal(noCogs[0].paid, null);
});

test("closed month: tiles from the month close, LER paid and unpaid with owner comp $6,396 a month", () => {
  const m = parseClosedMonth({
    schema: 1, kind: "closed_month", month: "2026-09", status: "final",
    revenue: 41234.56, revenue_by_stream: { in_store: 30000, delivery: 1500, catering: 9000, concessions: 0, other: 734.56 },
    cogs: 9100, gross_profit: 32134.56, wages: 15000, employer_tax: 1300, pre_tax_profit: -1760.16,
    rolling_12: { months: 12, revenue: 401234, pre_tax_profit: -12345, seller_months: 8 },
  })!;
  const t = closedMonthTiles(m);
  assert.equal(t.lerPaid, 1.42);
  assert.equal(t.lerUnpaid, 1.97);
  assert.equal(t.cogsPct, 0.221);
  assert.equal(t.preTaxPct, -0.043);
  assert.equal(parseClosedMonth({ schema: 1, kind: "closed_month", month: "Sept" }), null);
});
