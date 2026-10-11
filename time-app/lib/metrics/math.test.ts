// The Metrics page's arithmetic (bj-finance #671, rulings 2026-10-10):
// pace against the $600K seasonal target, LER paid and unpaid, and catering
// counted by event date. Written before the code (Alina's test-first rule for
// metric math).
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { monthProgress, targetFor, type SalesTargetRow } from "./targets.ts";
import { SALES_TARGET_SEED } from "./salesTargetsSeed.ts";
import { ler, lerPair, OWNER_COMP_WEEKLY, OWNER_COMP_MONTHLY } from "./ler.ts";
import { arSummary, bookedEvidence, cateringByDay, cateringValue, isBooked, type DealRow } from "./catering.ts";
import { addDays, daysInMonth, lastWeeks, mondayOf } from "./dates.ts";

// ---- targets and pace -----------------------------------------------------------

test("the seed is the 3-stream table with December PAX at $5,000; the year is not rescaled", () => {
  for (const year of ["2026", "2027"]) {
    const rows = SALES_TARGET_SEED.filter((r) => r.month.startsWith(year));
    assert.equal(rows.length, 36, year);
    assert.equal(rows.reduce((s, r) => s + r.amount, 0), 584_575, year);
    const sum = (stream: string) => rows.filter((r) => r.stream === stream).reduce((s, r) => s + r.amount, 0);
    assert.equal(sum("in_store"), 397_730);
    assert.equal(sum("catering"), 114_956);
    assert.equal(sum("concessions"), 71_889);
  }
  assert.equal(targetFor(SALES_TARGET_SEED, "2026-10-01", "catering")?.amount, 5_309);
  assert.equal(targetFor(SALES_TARGET_SEED, "2026-12-01", "concessions")?.amount, 5_000);
  assert.ok(SALES_TARGET_SEED.every((r) => r.measure === "net"));
});

test("the whole-business target is the sum of the month's streams, provisional when concessions are", () => {
  const dec = targetFor(SALES_TARGET_SEED, "2026-12-01", "all");
  assert.equal(dec?.amount, 25_240);
  assert.equal(dec?.provisional, true);
  assert.equal(targetFor(SALES_TARGET_SEED, "2026-10-01", "all")?.amount, 34_190);
  assert.equal(targetFor(SALES_TARGET_SEED, "2026-10-01", "in_store")?.provisional, false);
  // An explicit 'all' row overrides the sum.
  const rows: SalesTargetRow[] = [...SALES_TARGET_SEED, { month: "2026-10-01", stream: "all", amount: 50_000, basis: "x" }];
  assert.equal(targetFor(rows, "2026-10-01", "all")?.amount, 50_000);
  assert.equal(targetFor([], "2026-10-01", "all"), null);
});

test("the seed matches migration 39's INSERT, so the bundled fallback and the table agree", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(new URL("../../supabase/migration_39.sql", import.meta.url));
  const sql = await readFile(path, "utf8").catch(() => null);
  if (sql === null) return; // the migration ships in its own pull request
  const rows = [...sql.matchAll(/\('(in_store|catering|concessions)',\s*(\d{1,2}),\s*(\d+\.\d{2})\)/g)];
  assert.equal(rows.length, 36);
  for (const [, stream, month, amount] of rows) {
    const t = targetFor(SALES_TARGET_SEED, `2026-${month.padStart(2, "0")}-01`, stream as "catering");
    assert.equal(t?.amount, Number(amount), `${stream} ${month}`);
  }
});

test("a stream with no target row has no target", () => {
  assert.equal(targetFor(SALES_TARGET_SEED, "2028-12-01", "concessions"), null);
  assert.equal(targetFor(SALES_TARGET_SEED, "2028-12-01", "all"), null);
});

test("pace = target x day / days in month, the as-of day included", () => {
  // Oct 10 of 31 days: 34,190 x 10/31 = 11,029.03
  const p = monthProgress({ target: 34_190, actual: 10_000, asOf: "2026-10-10" });
  assert.equal(p.day, 10);
  assert.equal(p.days, 31);
  assert.equal(p.paceToDate, 11_029.03);
  assert.equal(p.vsPace, -1_029.03);
  assert.equal(p.pctOfPace, 0.907);
  assert.equal(p.pctOfTarget, 0.292);
  // On the last day the pace is the whole target.
  assert.equal(monthProgress({ target: 25_498, actual: 0, asOf: "2026-02-28" }).paceToDate, 25_498);
});

test("pace with no target says so rather than dividing by zero", () => {
  const p = monthProgress({ target: null, actual: 500, asOf: "2026-10-10" });
  assert.equal(p.paceToDate, null);
  assert.equal(p.vsPace, null);
  assert.equal(p.pctOfPace, null);
});

// ---- LER ---------------------------------------------------------------------------

test("owner comp at the house rate: $630 + $846 a week, $6,396 a month", () => {
  assert.equal(OWNER_COMP_WEEKLY, 1476);
  assert.equal(OWNER_COMP_MONTHLY, 6396); // 1476 x 52 / 12
});

test("LER = gross profit / (wages + employer tax + owner comp)", () => {
  assert.equal(ler({ grossProfit: 20_000, wages: 8_000, employerTax: 800, ownerComp: 1_200 }), 2);
  assert.equal(ler({ grossProfit: 0, wages: 1, employerTax: 0, ownerComp: 0 }), 0);
});

test("LER paid and unpaid differ only by owner comp", () => {
  const monthly = lerPair({ grossProfit: 32_134.56, wages: 15_000, employerTax: 1_300 }, "month");
  assert.equal(monthly.paid, 1.42); // 32,134.56 / 22,696
  assert.equal(monthly.unpaid, 1.97); // 32,134.56 / 16,300
  const weekly = lerPair({ grossProfit: 6_000, wages: 2_500, employerTax: 224 }, "week");
  assert.equal(weekly.paid, 1.43); // 6,000 / 4,200
  assert.equal(weekly.unpaid, 2.2); // 6,000 / 2,724
});

test("LER with no labour cost or a missing input is unknown, never infinite", () => {
  assert.equal(ler({ grossProfit: 100, wages: 0, employerTax: 0, ownerComp: 0 }), null);
  assert.equal(ler({ grossProfit: null, wages: 100, employerTax: 0, ownerComp: 0 }), null);
  assert.equal(lerPair({ grossProfit: 100, wages: null, employerTax: 0 }, "week").paid, null);
});

// ---- catering by event date ---------------------------------------------------------

const TODAY = "2026-10-10";

function deal(over: Partial<DealRow>): DealRow {
  return {
    id: 1,
    stage: "Booked Paid",
    payment_status: "Paid in Full",
    event_date: "2026-10-04",
    created_at: "2026-09-01T12:00:00Z",
    subtotal_pretax: 1000,
    total_with_tax: 1080,
    amount_paid: 1080,
    company: "Acme",
    source: "form",
    archived: 0,
    ...over,
  };
}

test("booked means booked: Booked Unpaid/Paid, any payment, or Event Complete for a past event", () => {
  assert.equal(isBooked(deal({ stage: "Booked Unpaid", payment_status: "None", amount_paid: 0 }), TODAY), true);
  assert.equal(isBooked(deal({ stage: "Open", payment_status: "None", amount_paid: 0 }), TODAY), false);
  assert.equal(isBooked(deal({ stage: "Sent Quote", payment_status: "None", amount_paid: 0 }), TODAY), false);
  assert.equal(isBooked(deal({ stage: "Closed Lost", payment_status: "None", amount_paid: 0 }), TODAY), false);
  assert.equal(isBooked(deal({ stage: "Event Complete", event_date: "2026-10-04", payment_status: "None", amount_paid: 0 }), TODAY), true);
  // A deposit on a deal the sweep has wrongly closed still counts.
  assert.equal(isBooked(deal({ stage: "Event Complete", event_date: "2026-11-04", payment_status: "Deposit Paid", amount_paid: 300 }), TODAY), true);
});

test("the 10-06 sweep defect: Event Complete on a FUTURE event with no payment is not taken as booked, and is flagged", () => {
  const flipped = deal({ id: 25425, stage: "Event Complete", event_date: "2026-11-20", payment_status: "None", amount_paid: 0 });
  assert.equal(isBooked(flipped, TODAY), false);
  assert.equal(bookedEvidence(flipped, TODAY), "suspect_event_complete");
  // ...unless the stage history shows it was booked before the flip.
  assert.equal(isBooked(flipped, TODAY, new Set([25425])), true);
  assert.equal(bookedEvidence(flipped, TODAY, new Set([25425])), "stage_history");
});

test("a booked deal's numbers are the same whatever its booked stage, so the flip moves nothing", () => {
  const booked = deal({ stage: "Booked Paid", event_date: "2026-11-04" });
  const flipped = deal({ stage: "Event Complete", event_date: "2026-11-04" });
  assert.deepEqual(cateringByDay([booked], "2026-11-01", "2026-11-30", TODAY), cateringByDay([flipped], "2026-11-01", "2026-11-30", TODAY));
});

test("catering sales are the pre-tax subtotal, on the event date, booked deals only", () => {
  const deals = [
    deal({ id: 1, event_date: "2026-10-02", subtotal_pretax: 1000 }),
    deal({ id: 2, event_date: "2026-10-02T14:00:00", subtotal_pretax: 250.5 }),
    deal({ id: 3, event_date: "2026-10-05", subtotal_pretax: 400, stage: "Sent Quote", payment_status: "None", amount_paid: 0 }),
    deal({ id: 4, event_date: "2026-09-30", subtotal_pretax: 999 }),
    deal({ id: 5, event_date: "2026-10-06", subtotal_pretax: null, total_with_tax: 540 }),
    deal({ id: 6, event_date: "2026-10-07", archived: 1 }),
  ];
  const days = cateringByDay(deals, "2026-10-01", "2026-10-31", TODAY);
  assert.equal(days.byDay["2026-10-02"], 1250.5);
  assert.equal(days.byDay["2026-10-05"] ?? 0, 0);
  assert.equal(days.byDay["2026-10-06"], 500); // 540 / 1.08, the Philly 8% backed out
  assert.equal(days.byDay["2026-10-07"] ?? 0, 0);
  assert.equal(days.total, 1750.5);
  assert.deepEqual(days.estimatedIds, [5]);
  assert.equal(cateringValue(deal({ subtotal_pretax: null, total_with_tax: null })), null);
});

// ---- catering AR -------------------------------------------------------------------------

test("AR: balance = total with tax - amount paid; Paid in Full owes nothing; due by the event date", () => {
  const deals = [
    deal({ id: 1, event_date: "2026-10-03", total_with_tax: 1080, amount_paid: 300, payment_status: "Deposit Paid", stage: "Event Complete" }),
    deal({ id: 2, event_date: "2026-10-20", total_with_tax: 500, amount_paid: 0, payment_status: "None", stage: "Booked Unpaid" }),
    deal({ id: 3, event_date: "2026-10-25", total_with_tax: 900, amount_paid: 0, payment_status: "Paid in Full" }),
    deal({ id: 4, event_date: "2026-11-02", total_with_tax: 700, amount_paid: 200, payment_status: "Deposit Paid", stage: "Booked Paid" }),
    deal({ id: 5, event_date: "2026-09-12", total_with_tax: 400, amount_paid: 0, payment_status: "None", stage: "Event Complete" }),
    deal({ id: 6, event_date: "2026-10-28", total_with_tax: 800, amount_paid: 0, payment_status: "None", stage: "Sent Quote" }),
  ];
  const ar = arSummary(deals, TODAY);
  assert.equal(ar.dueThisMonth, 1280); // 780 (Oct 3, overdue) + 500 (Oct 20)
  assert.equal(ar.overdue, 1180); // 780 + 400 from September
  assert.equal(ar.overdueThisMonth, 780);
  assert.equal(ar.notYetDueThisMonth, 500);
  assert.equal(ar.laterMonths, 500); // Nov 2
  assert.deepEqual(ar.rows.map((r) => r.id), [5, 1, 2, 4]);
});

// ---- dates ----------------------------------------------------------------------------------

test("weeks run Monday to Sunday", () => {
  assert.equal(mondayOf("2026-10-10"), "2026-10-05"); // a Saturday
  assert.equal(mondayOf("2026-10-11"), "2026-10-05"); // a Sunday
  assert.equal(mondayOf("2026-10-12"), "2026-10-12");
  assert.deepEqual(lastWeeks("2026-10-10", 3), ["2026-09-21", "2026-09-28", "2026-10-05"]);
  assert.equal(daysInMonth("2028-02-10"), 29);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});
