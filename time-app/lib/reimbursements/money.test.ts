// The money rules of a Travel Reimbursement (bj-finance #210, rulings 27, 33,
// 38): the Mileage rate is the IRS business standard rate in effect on the
// trip date, read from public.mileage_rates; money is integer cents, rounded
// half-up; each leg of a computed route is rounded to 0.1 mi half-up.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  centsFromDollars,
  legMiles,
  mileageCents,
  milesFromInput,
  rateForDate,
  reimbursementCents,
  type MileageRate,
} from "./money.ts";

const RATES: MileageRate[] = [
  { starts_on: "2026-07-01", cents_per_mile: 76 },
  { starts_on: "2025-01-01", cents_per_mile: 70 },
  { starts_on: "2026-01-01", cents_per_mile: 72.5 },
];

test("rateForDate: the rate in effect on the trip date, whatever order the table is read in", () => {
  assert.equal(rateForDate(RATES, "2026-06-30")?.cents_per_mile, 72.5);
  assert.equal(rateForDate(RATES, "2026-07-01")?.cents_per_mile, 76);
  assert.equal(rateForDate(RATES, "2026-10-08")?.cents_per_mile, 76);
  assert.equal(rateForDate(RATES, "2026-01-01")?.cents_per_mile, 72.5);
  assert.equal(rateForDate(RATES, "2025-12-31")?.cents_per_mile, 70);
});

test("rateForDate: no rate before the first one in the table", () => {
  assert.equal(rateForDate(RATES, "2024-12-31"), null);
  assert.equal(rateForDate([], "2026-10-08"), null);
});

test("rateForDate: a rate read back from Postgres numeric as a string still counts", () => {
  const fromDb = [{ starts_on: "2026-01-01", cents_per_mile: "72.50" as unknown as number }];
  assert.equal(rateForDate(fromDb, "2026-03-01")?.cents_per_mile, 72.5);
});

test("mileageCents: miles times the rate, half-up to the cent", () => {
  // 12.3 mi x 72.5c = 891.75c -> 892
  assert.equal(mileageCents(12.3, 72.5), 892);
  // 10.0 mi x 76c = 760c
  assert.equal(mileageCents(10, 76), 760);
  // 0.1 mi x 72.5c = 7.25c -> 7
  assert.equal(mileageCents(0.1, 72.5), 7);
  // 0.3 mi x 72.5c = 21.75c -> 22
  assert.equal(mileageCents(0.3, 72.5), 22);
  // 0.5 x 72.5 = 36.25 -> 36 ; 0.7 x 72.5 = 50.75 -> 51
  assert.equal(mileageCents(0.5, 72.5), 36);
  assert.equal(mileageCents(0.7, 72.5), 51);
  assert.equal(mileageCents(0, 76), 0);
});

test("mileageCents: exactly half a cent rounds up, without floating-point drift", () => {
  // 0.2 mi x 72.5c = 14.5c -> 15 (floating point gives 14.499999...)
  assert.equal(mileageCents(0.2, 72.5), 15);
  // 1.8 mi x 72.5c = 130.5c -> 131
  assert.equal(mileageCents(1.8, 72.5), 131);
});

test("reimbursementCents: mileage at the trip date's rate plus tolls and parking", () => {
  const before = reimbursementCents({ trip_date: "2026-06-30", miles: 10, tolls_cents: 450, parking_cents: 1200, mileage_cents_override: null }, RATES);
  assert.deepEqual(before, { rate: 72.5, mileage_cents: 725, tolls_cents: 450, parking_cents: 1200, total_cents: 2375 });
  const after = reimbursementCents({ trip_date: "2026-07-01", miles: 10, tolls_cents: 0, parking_cents: 0, mileage_cents_override: null }, RATES);
  assert.deepEqual(after, { rate: 76, mileage_cents: 760, tolls_cents: 0, parking_cents: 0, total_cents: 760 });
});

test("reimbursementCents: an Adjustment to the mileage amount replaces the computed one", () => {
  const r = reimbursementCents({ trip_date: "2026-07-01", miles: 10, tolls_cents: 100, parking_cents: 0, mileage_cents_override: 500 }, RATES);
  assert.equal(r.mileage_cents, 500);
  assert.equal(r.total_cents, 600);
});

test("reimbursementCents: no rate for the trip date means no mileage amount, not a guess", () => {
  const r = reimbursementCents({ trip_date: "2024-06-01", miles: 10, tolls_cents: 100, parking_cents: 0, mileage_cents_override: null }, RATES);
  assert.equal(r.rate, null);
  assert.equal(r.mileage_cents, null);
  assert.equal(r.total_cents, null);
});

test("centsFromDollars: typed amounts become integer cents", () => {
  assert.equal(centsFromDollars("12.50"), 1250);
  assert.equal(centsFromDollars("$4"), 400);
  assert.equal(centsFromDollars("4.5"), 450);
  assert.equal(centsFromDollars(" 0.07 "), 7);
  assert.equal(centsFromDollars(""), 0);
  assert.equal(centsFromDollars(null), 0);
  assert.equal(centsFromDollars(19.99), 1999);
});

test("centsFromDollars: refuses what is not an amount", () => {
  assert.equal(centsFromDollars("-3"), null);
  assert.equal(centsFromDollars("1.234"), null);
  assert.equal(centsFromDollars("abc"), null);
  assert.equal(centsFromDollars("100000"), null);
});

test("milesFromInput: typed miles to one decimal place", () => {
  assert.equal(milesFromInput("12.3"), 12.3);
  assert.equal(milesFromInput(7), 7);
  assert.equal(milesFromInput("12.34"), null);
  assert.equal(milesFromInput("-1"), null);
  assert.equal(milesFromInput("2000.1"), null);
  assert.equal(milesFromInput(""), null);
});

test("legMiles: a route leg in meters, rounded to 0.1 mi half-up", () => {
  // 1609.344 m = 1 mi exactly
  assert.equal(legMiles(1609.344), 1);
  // 0.05 mi = 80.4672 m -> 0.1
  assert.equal(legMiles(80.4672), 0.1);
  // 0.04 mi -> 0
  assert.equal(legMiles(64.37), 0);
  // 5.26 mi -> 5.3 ; 5.24 mi -> 5.2
  assert.equal(legMiles(5.26 * 1609.344), 5.3);
  assert.equal(legMiles(5.24 * 1609.344), 5.2);
});
