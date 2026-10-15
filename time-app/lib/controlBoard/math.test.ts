// The control board's derived numbers (bj-finance #692 spec, Alina
// 2026-10-13), pinned before they are drawn. Round invented figures so each
// expectation can be checked by hand; crm-app is public.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeBoard, monthSales, monthStart, trendFactor, type BoardInputs, type DailySalesRow, type MonthlySalesRow } from "./math.ts";

const close = (a: number | null, b: number, msg?: string) => {
  assert.ok(a != null, msg ?? `expected ${b}, got null`);
  assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} expected ${b}, got ${a}`);
};

const FULL: BoardInputs = {
  salesInStore: 600_000,
  salesCatering: 400_000,
  cogsPct: 0.2,
  payrollPct: 0.3,
  primeCostPct: 0.5,
  fica: { rate: 0.08, wageCap: null },
  futa: { rate: 0.01, wageCap: 10_000 },
  paUc: { rate: 0.02, wageCap: 20_000 },
  workersCompPer100: 1,
  salaried: [
    { id: "a", name: "Person A", salary: 50_000 },
    { id: "b", name: "Person B", salary: 30_000 },
  ],
};

test("fixed payroll is the salaries plus employer taxes WITH their wage caps plus workers' comp", () => {
  const r = computeBoard(FULL);
  const [a, b] = r.salaried;
  // A: FICA 8% of all 50,000; FUTA 1% of the first 10,000; UC 2% of the first 20,000; WC $1 per $100.
  close(a.fica, 4_000); close(a.futa, 100); close(a.uc, 400); close(a.wc, 500); close(a.total, 55_000);
  close(b.fica, 2_400); close(b.futa, 100); close(b.uc, 400); close(b.wc, 300); close(b.total, 33_200);
  close(r.salaries.value, 80_000);
  close(r.fixedPayroll.value, 88_200);
  close(r.fixedTaxesWc.value, 8_200);
});

test("hourly dollars net hourly staff's taxes and WC out of the payroll target, at full rates with no caps", () => {
  const r = computeBoard(FULL);
  close(r.salesTotal.value, 1_000_000);
  close(r.totalPayroll.value, 300_000);
  close(r.hourlyPool.value, 211_800, "payroll target less fixed payroll");
  close(r.hourlyLoad.value, 0.12, "FICA + FUTA + UC + WC, no caps");
  // Worked by hand: 211,800 / 1.12 = 189,107.142857 of wages and 22,692.857143 of their taxes and WC.
  close(r.hourlyDollars.value, 189_107.142857);
  close(r.hourlyLoadDollars.value, 22_692.857143);
  close((r.hourlyDollars.value ?? 0) + (r.hourlyLoadDollars.value ?? 0), 211_800, "hourly wages plus their taxes use the whole pool");
  close(r.hourlyGoalPct.value, 0.189107142857, "hourly goal = hourly dollars / sales estimate");
  // Salaried 8,200 plus hourly 22,692.857143, over 1,000,000 of sales.
  close(r.allTaxesWcPct.value, 0.030892857143);
});

test("the cost targets are shares of the whole sales estimate; prime cost shown is COGS plus payroll at target", () => {
  const r = computeBoard(FULL);
  close(r.cogsDollars.value, 200_000);
  close(r.primeDollars.value, 500_000);
  close(r.primeShare.value, 0.5);
});

test("with nobody salaried, fixed payroll is zero, not missing", () => {
  const r = computeBoard({ ...FULL, salaried: [] });
  close(r.fixedPayroll.value, 0);
  close(r.hourlyPool.value, 300_000);
});

test("a missing input is missing, never zero: every number that needs it says what it waits for", () => {
  const r = computeBoard({ ...FULL, salesCatering: null });
  assert.equal(r.salesTotal.value, null);
  assert.deepEqual(r.salesTotal.needs, ["Catering sales estimate"]);
  assert.equal(r.hourlyGoalPct.value, null);
  assert.ok(r.hourlyGoalPct.needs.includes("Catering sales estimate"));
  close(r.fixedPayroll.value, 88_200, "fixed payroll does not need the sales estimate");

  const noRate = computeBoard({ ...FULL, futa: null });
  assert.equal(noRate.fixedPayroll.value, null);
  assert.deepEqual(noRate.fixedPayroll.needs, ["FUTA"]);
  assert.equal(noRate.salaried[0].futa, null);
  close(noRate.salaried[0].fica, 4_000, "the other taxes still show");
  assert.equal(noRate.hourlyLoad.value, null);
  assert.equal(noRate.hourlyDollars.value, null);

  const noSalary = computeBoard({ ...FULL, salaried: [{ id: "a", name: "Person A", salary: null }] });
  assert.equal(noSalary.fixedPayroll.value, null);
  assert.deepEqual(noSalary.fixedPayroll.needs, ["Person A's salary"]);
  assert.equal(noSalary.salaries.value, null);

  const nothing = computeBoard({
    salesInStore: null, salesCatering: null, cogsPct: null, payrollPct: null, primeCostPct: null,
    fica: null, futa: null, paUc: null, workersCompPer100: null, salaried: [],
  });
  for (const k of ["salesTotal", "cogsDollars", "totalPayroll", "hourlyPool", "hourlyDollars", "hourlyGoalPct"] as const) {
    assert.equal(nothing[k].value, null, k);
    assert.ok(nothing[k].needs.length > 0, k);
  }
});

test("a sales estimate of zero gives no hourly goal rather than dividing by zero", () => {
  const r = computeBoard({ ...FULL, salesInStore: 0, salesCatering: 0 });
  assert.equal(r.hourlyGoalPct.value, null);
});

// ---- the trend factor ------------------------------------------------------------------

const monthly = (month: string, source: "qbo" | "seller", in_store: number): MonthlySalesRow => ({ month, source, in_store });

function fullMonthDaily(month: string, perDay: number, source: "square" | "seller" = "square"): DailySalesRow[] {
  const out: DailySalesRow[] = [];
  const next = monthStart(month, 1);
  for (let d = new Date(`${month}T12:00:00Z`); d.toISOString().slice(0, 10) < next; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push({ day: d.toISOString().slice(0, 10), in_store: perDay, basis: "booked", source });
  }
  return out;
}

test("the trend factor is last full month's in-store sales over the same month a year earlier, both shown", () => {
  const t = trendFactor("2030-10-14", [monthly("2030-09-01", "qbo", 9_000), monthly("2029-09-01", "seller", 10_000)], []);
  assert.equal(t.lastMonth.month, "2030-09-01");
  assert.equal(t.sameMonthLastYear.month, "2029-09-01");
  assert.equal(t.lastMonth.value, 9_000);
  assert.equal(t.lastMonth.source, "qbo");
  assert.equal(t.sameMonthLastYear.value, 10_000);
  assert.equal(t.sameMonthLastYear.source, "seller");
  close(t.factor.value, 0.9);
});

test("January's last full month is December of the year before", () => {
  const t = trendFactor("2031-01-05", [], []);
  assert.equal(t.lastMonth.month, "2030-12-01");
  assert.equal(t.sameMonthLastYear.month, "2029-12-01");
});

test("QBO first, the seller's books when there is no QBO month", () => {
  const both = monthSales("2030-09-01", [monthly("2030-09-01", "seller", 1), monthly("2030-09-01", "qbo", 2)], []);
  assert.equal(both.value, 2);
  assert.equal(both.source, "qbo");
  const seller = monthSales("2030-09-01", [monthly("2030-09-01", "seller", 1)], []);
  assert.equal(seller.source, "seller");
});

test("with no month on file, the daily sales count only when every day of the month has a row", () => {
  const all = monthSales("2030-09-01", [], fullMonthDaily("2030-09-01", 100));
  assert.equal(all.value, 3_000);
  assert.equal(all.source, "daily");
  const partial = monthSales("2030-09-01", [], fullMonthDaily("2030-09-01", 100).slice(1));
  assert.equal(partial.value, null, "a missing day is unknown, not zero");
  assert.match(partial.note, /1 of 30 days missing/);
  const unsettled = fullMonthDaily("2030-09-01", 100);
  unsettled[0] = { ...unsettled[0], basis: "in_transit" };
  assert.match(monthSales("2030-09-01", [], unsettled).note, /1 not settled yet/);
});

test("when either month is missing the trend factor is missing, never 0 or 1", () => {
  const t = trendFactor("2030-10-14", [monthly("2030-09-01", "qbo", 9_000)], []);
  assert.equal(t.factor.value, null);
  assert.deepEqual(t.factor.needs, ["in-store sales for 2029-09"]);
  assert.equal(t.sameMonthLastYear.value, null);
  assert.equal(t.sameMonthLastYear.note, "no sales on file");
  const zero = trendFactor("2030-10-14", [monthly("2030-09-01", "qbo", 9_000), monthly("2029-09-01", "seller", 0)], []);
  assert.equal(zero.factor.value, null);
});
