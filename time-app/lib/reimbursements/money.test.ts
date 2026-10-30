// The money rules of a Travel Reimbursement (bj-finance #210, rulings 27, 33,
// 38): the Mileage rate is the IRS business standard rate in effect on the
// trip date, read from public.mileage_rates, and for a Catering Event never
// more a mile than its quote charged the customer (the owner, 2026-10-29);
// money is integer cents, rounded half-up; each leg of a computed route is
// rounded to 0.1 mi half-up.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  amountText,
  amountsBeforeAdjustments,
  decideRefusal,
  noMilesRefusal,
  centsFromDollars,
  fieldCents,
  dollarsText,
  legMiles,
  mileageCents,
  mileageRateText,
  milesFromInput,
  rateForDate,
  rateForTrip,
  reimbursementCents,
  totalText,
  zeroCapText,
  type MileageCap,
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
  assert.deepEqual(before, { rate: 72.5, capped: false, mileage_cents: 725, tolls_cents: 450, parking_cents: 1200, total_cents: 2375 });
  const after = reimbursementCents({ trip_date: "2026-07-01", miles: 10, tolls_cents: 0, parking_cents: 0, mileage_cents_override: null }, RATES);
  assert.deepEqual(after, { rate: 76, capped: false, mileage_cents: 760, tolls_cents: 0, parking_cents: 0, total_cents: 760 });
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

// ---------- a Catering Event's cap: what its quote charged (the owner, 2026-10-29) ----------
// The same cases as supabase/migration_49_verify.sql section 4.

const trip = { trip_date: "2026-10-07", miles: 10, tolls_cents: 0, parking_cents: 0, mileage_cents_override: null };

test("rateForTrip: the lower of the IRS rate and the cap; no cap is the IRS rate", () => {
  assert.deepEqual(rateForTrip(RATES, "2026-10-07", 72.5), { cents_per_mile: 72.5, capped: true });
  assert.deepEqual(rateForTrip(RATES, "2026-10-07", null), { cents_per_mile: 76, capped: false });
  assert.deepEqual(rateForTrip(RATES, "2026-10-07", undefined), { cents_per_mile: 76, capped: false });
  // A quote that charged more than the IRS rate pays the IRS rate.
  assert.deepEqual(rateForTrip(RATES, "2026-10-07", 90.5), { cents_per_mile: 76, capped: false });
  // Equal to the IRS rate is not capped.
  assert.deepEqual(rateForTrip(RATES, "2026-06-30", 72.5), { cents_per_mile: 72.5, capped: false });
  // A cap from Postgres numeric may arrive as a string.
  assert.deepEqual(rateForTrip(RATES, "2026-10-07", "72.50" as unknown as number), { cents_per_mile: 72.5, capped: true });
});

test("rateForTrip: a cap alone does not price a trip with no IRS rate", () => {
  assert.equal(rateForTrip(RATES, "2024-06-01", 72.5), null);
});

test("reimbursementCents: a Catering Event whose quote charged 72.5c a mile pays 72.5c, not the IRS 76c", () => {
  // 46.3 mi x 72.5c = 3356.75 -> 3357, plus tolls.
  const r = reimbursementCents({ ...trip, miles: 46.3, tolls_cents: 450, cap_cents_per_mile: 72.5 }, RATES);
  assert.deepEqual(r, { rate: 72.5, capped: true, mileage_cents: 3357, tolls_cents: 450, parking_cents: 0, total_cents: 3807 });
});

test("reimbursementCents: the Uber flat fee and errands have no cap: the IRS rate", () => {
  assert.equal(reimbursementCents({ ...trip, cap_cents_per_mile: null }, RATES).mileage_cents, 760);
  assert.equal(reimbursementCents(trip, RATES).mileage_cents, 760);
});

test("reimbursementCents: a Catering Event with no quote has no cap: the IRS rate", () => {
  // deal_mileage_cap() answers no cap (no_quote). 30.4 mi x 76c = 2310.4 -> 2310.
  const r = reimbursementCents({ ...trip, trip_date: "2026-10-21", miles: 30.4, cap_cents_per_mile: null }, RATES);
  assert.deepEqual(r, { rate: 76, capped: false, mileage_cents: 2310, tolls_cents: 0, parking_cents: 0, total_cents: 2310 });
  assert.equal(reimbursementCents({ ...trip, trip_date: "2026-06-30", cap_cents_per_mile: null }, RATES).rate, 72.5);
});

test("rateForTrip: a 0c cap (a quote that charged no mileage) pays 0c, capped", () => {
  assert.deepEqual(rateForTrip(RATES, "2026-10-07", 0), { cents_per_mile: 0, capped: true });
  assert.deepEqual(rateForTrip(RATES, "2026-10-07", "0.00" as unknown as number), { cents_per_mile: 0, capped: true });
});

test("reimbursementCents: a $0 mileage quote pays no mileage, but tolls and parking in full", () => {
  // deal_mileage_cap() answers 0c (no_rate_on_quote, no_miles_on_deal; migration 50), and since
  // migration 52 for a $0 quote that stores a per-mile rate too; migration_52_verify.sql checks the view's 1650.
  const r = reimbursementCents({ ...trip, miles: 3.2, tolls_cents: 450, parking_cents: 1200, cap_cents_per_mile: 0 }, RATES);
  assert.deepEqual(r, { rate: 0, capped: true, mileage_cents: 0, tolls_cents: 450, parking_cents: 1200, total_cents: 1650 });
});

test("reimbursementCents: an Adjustment's mileage replaces a 0c amount", () => {
  assert.equal(reimbursementCents({ ...trip, mileage_cents_override: 500, cap_cents_per_mile: 0 }, RATES).total_cents, 500);
});

test("zeroCapText: says why a 0c cap pays nothing; nothing for any other cap", () => {
  assert.match(zeroCapText({ cap_cents_per_mile: 0, basis: "no_rate_on_quote" })!, /quote charged the customer no mileage/);
  assert.equal(
    zeroCapText({ cap_cents_per_mile: 0, basis: "no_miles_on_deal" }),
    "the Catering Event's quote charged mileage, but its deal has no round-trip miles to price it by yet; they are being recalculated automatically, and the trip is repriced until it is paid",
  );
  assert.equal(
    zeroCapText({ cap_cents_per_mile: 0, basis: "no_miles_on_deal", recalc_failed: true }),
    "the Catering Event's quote charged mileage, but its deal has no round-trip miles to price it by; the automatic recalculation did not find them, so a manager should check the event's venue address, and the trip is repriced until it is paid",
  );
  assert.equal(zeroCapText({ cap_cents_per_mile: 72.5, basis: "quote_derived" }), null);
  assert.equal(zeroCapText({ cap_cents_per_mile: null, basis: "no_quote" }), null);
  assert.equal(zeroCapText(null), null);
});

test("reimbursementCents: an Adjustment's mileage still replaces the capped amount", () => {
  assert.equal(reimbursementCents({ ...trip, mileage_cents_override: 500, cap_cents_per_mile: 72.5 }, RATES).total_cents, 500);
});

test("amountsBeforeAdjustments: the amount before an Adjustment is at the capped rate", () => {
  const r = { ...trip, mileage_cents_override: 500, cap_cents_per_mile: 72.5 };
  const b = amountsBeforeAdjustments(r, [{ field: "mileage", old_cents: 725, new_cents: 500, adjusted_at: "2026-10-08T00:00:00Z" }], RATES)!;
  assert.equal(b.before.mileage_cents, 725);
});

test("mileageRateText: says whether the rate is the IRS rate or what the quote charged", () => {
  assert.equal(mileageRateText({ rate: 76, capped: false }), "76¢/mi, the IRS rate for the trip date");
  assert.match(mileageRateText({ rate: 72.5, capped: true }), /^72\.5¢\/mi, what the Catering Event's quote charged per mile/);
  assert.equal(mileageRateText({ rate: null, capped: false }), "no Mileage rate");
  assert.match(mileageRateText({ rate: 0, capped: true }, { cap_cents_per_mile: 0, basis: "no_rate_on_quote" }), /^0¢\/mi: the Catering Event's quote charged the customer no mileage/);
});

test("mileageRateText: the form's estimate, given the event's cap, gives the 0c reason only for a 0c cap", () => {
  // The form passes the event's cap whatever it is; only a 0c cap changes the wording.
  assert.match(mileageRateText({ rate: 0, capped: true }, { cap_cents_per_mile: 0, basis: "no_miles_on_deal" }), /^0¢\/mi: the Catering Event's quote charged mileage, but its deal has no round-trip miles/);
  assert.equal(mileageRateText({ rate: 72.5, capped: true }, { cap_cents_per_mile: 72.5, basis: "quote_derived" }), "72.5¢/mi, what the Catering Event's quote charged per mile (below the IRS rate)");
  assert.equal(mileageRateText({ rate: 76, capped: false }, { cap_cents_per_mile: 90.5, basis: "quote_derived" }), "76¢/mi, the IRS rate for the trip date");
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

// ---------- prototype review (rulings 40, 42, 43) -------------------------------------

const RATES_2026: MileageRate[] = [
  { starts_on: "2026-01-01", cents_per_mile: 72.5 },
  { starts_on: "2026-07-01", cents_per_mile: 76 },
];
const base = { trip_date: "2026-08-01", miles: 22, tolls_cents: 400, parking_cents: 800, mileage_cents_override: null };
const adj = (field: "mileage" | "tolls" | "parking", old_cents: number, new_cents: number, at: string) => ({ field, old_cents, new_cents, adjusted_at: at });

test("amountsBeforeAdjustments: none, so nothing to show as old -> new", () => {
  assert.equal(amountsBeforeAdjustments(base, [], RATES_2026), null);
});

test("amountsBeforeAdjustments: Mileage adjusted reads $16.72 -> $12.16, never a sum that does not add up (ruling 40)", () => {
  const r = { ...base, mileage_cents_override: 1216 };
  const b = amountsBeforeAdjustments(r, [adj("mileage", 1672, 1216, "2026-08-02T00:00:00Z")], RATES_2026)!;
  assert.deepEqual(b.adjusted, ["mileage"]);
  assert.equal(b.before.mileage_cents, 1672, "22.0 mi x 76c");
  assert.equal(b.before.total_cents, 2872, "$16.72 + $4.00 + $8.00");
  assert.equal(reimbursementCents(r, RATES_2026).mileage_cents, 1216);
});

test("amountsBeforeAdjustments: tolls or parking adjusted twice is old (first) -> new (now)", () => {
  const r = { ...base, parking_cents: 300 };
  const b = amountsBeforeAdjustments(
    r,
    [adj("parking", 500, 300, "2026-08-03T00:00:00Z"), adj("parking", 800, 500, "2026-08-02T00:00:00Z")],
    RATES_2026,
  )!;
  assert.deepEqual(b.adjusted, ["parking"]);
  assert.equal(b.before.parking_cents, 800);
  assert.equal(b.before.mileage_cents, 1672);
  assert.equal(b.before.total_cents, 2872, "$16.72 + $4.00 + $8.00");
});

test("amountsBeforeAdjustments: an amount staff changed since its Adjustment is not shown as adjusted", () => {
  // Mileage override dropped by a staff edit; tolls retyped after an Adjustment.
  const r = { ...base, tolls_cents: 900 };
  const b = amountsBeforeAdjustments(r, [adj("mileage", 1672, 1216, "2026-08-02T00:00:00Z"), adj("tolls", 400, 200, "2026-08-02T00:00:00Z")], RATES_2026);
  assert.equal(b, null);
});

test("amountText and totalText: an adjusted amount reads \"$16.72 → $12.16 (adjusted)\", the others as they are, the total before → now (ruling 40)", () => {
  const r = { ...base, mileage_cents_override: 1216 };
  const shown = { amounts: reimbursementCents(r, RATES_2026), before_adjustments: amountsBeforeAdjustments(r, [adj("mileage", 1672, 1216, "2026-08-02T00:00:00Z")], RATES_2026) };
  assert.equal(amountText(shown, "mileage"), "$16.72 → $12.16 (adjusted)");
  assert.equal(amountText(shown, "tolls"), "$4.00");
  assert.equal(amountText(shown, "parking"), "$8.00");
  assert.equal(totalText(shown), "$28.72 → $24.16");
});

test("amountText and totalText: nothing adjusted reads each amount and the total plainly", () => {
  const shown = { amounts: reimbursementCents(base, RATES_2026), before_adjustments: null };
  assert.equal(amountText(shown, "mileage"), "$16.72");
  assert.equal(totalText(shown), "$28.72");
});

test("decideRefusal approve: no Mileage rate for the trip date means no total, so no Approve (ruling 42)", () => {
  const none = reimbursementCents({ ...base, trip_date: "2025-06-01" }, RATES_2026);
  assert.match(decideRefusal("approve", { ...base, trip_date: "2025-06-01", amounts: none }) ?? "", /no Mileage rate for 2025-06-01/);
  assert.equal(decideRefusal("approve", { ...base, amounts: reimbursementCents(base, RATES_2026) }), null);
  // An Adjustment to the Mileage gives it a total.
  const overridden = { ...base, trip_date: "2025-06-01", mileage_cents_override: 1000 };
  assert.equal(decideRefusal("approve", { ...overridden, amounts: reimbursementCents(overridden, RATES_2026) }), null);
});

test("decideRefusal approve: a Catering Event whose quote charged mileage but whose deal has no round-trip miles is refused while they are recalculated (the owner, 2026-10-29)", () => {
  const noMiles = { cap_cents_per_mile: 0, basis: "no_miles_on_deal" } as const;
  const priced = (over: { miles?: number; trip_date?: string; mileage_cents_override?: number } = {}, cap: MileageCap | null = noMiles) => {
    const r = { ...base, ...over, cap_cents_per_mile: cap?.cap_cents_per_mile ?? null };
    return { ...r, mileage_cap: cap, amounts: reimbursementCents(r, RATES_2026) };
  };
  const refused = decideRefusal("approve", priced());
  assert.equal(
    refused,
    "Its Catering Event's quote charged mileage, but the deal has no round-trip miles, so its miles pay 0¢. They are being recalculated automatically; once they are in, approve it.",
  );
  assert.equal(priced().amounts.mileage_cents, 0, "it is refused because its miles price at 0c");
  // A miles recalculation that did not find the miles: a manager checks the venue address.
  assert.equal(
    decideRefusal("approve", priced({}, { ...noMiles, recalc_failed: true })),
    "Its Catering Event's quote charged mileage, but the deal has no round-trip miles, so its miles pay 0¢. The automatic recalculation did not find them, so a manager should check the venue address on the deal; once the miles are in, approve it.",
  );
  // Once the deal's miles land the cap is the quote's rate and it is approved.
  assert.equal(decideRefusal("approve", priced({}, { cap_cents_per_mile: 72, basis: "quote_derived" })), null);
  // A quote that charged no mileage is 0c on purpose: approved, tolls and parking pay.
  const walkable = priced({}, { cap_cents_per_mile: 0, basis: "no_rate_on_quote" });
  assert.equal(decideRefusal("approve", walkable), null);
  assert.equal(walkable.amounts.total_cents, 1200);
  // No miles on the trip: the cap prices nothing, so tolls and parking are approved.
  assert.equal(decideRefusal("approve", priced({ miles: 0 })), null);
  // A Mileage Adjustment replaces the capped amount: the Approver set it, with evidence.
  assert.equal(decideRefusal("approve", priced({ mileage_cents_override: 1500 })), null);
  // No rate for the trip date is said first: there is no total at all.
  assert.match(decideRefusal("approve", priced({ trip_date: "2025-06-01" })) ?? "", /no Mileage rate for 2025-06-01/);
  // Errands and deals without a cap are never refused for it.
  assert.equal(decideRefusal("approve", priced({}, null)), null);
});

test("decideRefusal: paid_outside_payroll is refused while the deal has no round-trip miles; reject, send back and adjust never are", () => {
  const r = { ...base, mileage_cap: { cap_cents_per_mile: 0, basis: "no_miles_on_deal" as const }, amounts: { total_cents: null } };
  assert.equal(
    decideRefusal("paid_outside_payroll", r),
    "Its Catering Event's quote charged mileage, but the deal has no round-trip miles, so its miles pay 0¢. They are being recalculated automatically; once they are in, mark it Paid outside payroll.",
  );
  assert.equal(decideRefusal("paid_outside_payroll", { ...r, mileage_cap: null }), null);
  for (const action of ["reject", "send_back", "adjust"] as const) assert.equal(decideRefusal(action, r), null, action);
});

test("noMilesRefusal: names the step once the deal's miles are in", () => {
  const r = { ...base, mileage_cap: { cap_cents_per_mile: 0, basis: "no_miles_on_deal" as const }, amounts: { total_cents: 1200 } };
  assert.match(noMilesRefusal(r, "mark it Paid outside payroll") ?? "", /recalculated automatically; once they are in, mark it Paid outside payroll\.$/);
  assert.match(
    noMilesRefusal({ ...r, mileage_cap: { ...r.mileage_cap, recalc_failed: true } }, "approve it") ?? "",
    /check the venue address on the deal; once the miles are in, approve it\.$/,
  );
  assert.equal(noMilesRefusal({ ...r, mileage_cap: { cap_cents_per_mile: 0, basis: "no_rate_on_quote" } }, "approve it"), null);
});

test("fieldCents and dollarsText: the Adjust panel shows and pre-fills the current amount (ruling 43)", () => {
  const a = reimbursementCents(base, RATES_2026);
  assert.equal(fieldCents(a, "mileage"), 1672);
  assert.equal(fieldCents(a, "tolls"), 400);
  assert.equal(fieldCents(a, "parking"), 800);
  assert.equal(fieldCents(reimbursementCents({ ...base, trip_date: "2025-06-01" }, RATES_2026), "mileage"), null);
  assert.equal(dollarsText(1672), "16.72");
  assert.equal(dollarsText(0), "0.00");
  assert.equal(dollarsText(null), "");
  assert.equal(centsFromDollars(dollarsText(1672)), 1672);
});
