// The money of a Travel Reimbursement (bj-finance #210).
//
//   * Mileage rate: the IRS business standard mileage rate in effect on the
//     trip date (rulings 27, 33). The rates live in public.mileage_rates
//     (migration 37), one row per start date, added by hand when the IRS
//     announces a new one (ruling 38). For a Catering Event, never more per
//     mile than the event's quote charged the customer (the owner,
//     2026-10-29): the lower of the two. A quote that charged $0 mileage
//     caps it at 0c (migrations 50 and 52). No quote, a quote that charged the Uber
//     flat fee, and Groceries / errands have no cap: the IRS rate. The
//     database works out the cap from the quote (deal_mileage_cap(),
//     migrations 49, 50 and 52); this module is
//     told it, as Priceable.cap_cents_per_mile. Every reimbursement not yet
//     Paid is priced at its trip's rate whenever it is read: nothing is frozen
//     at submit, so a rate typed in late still reaches every unpaid item.
//   * Money is integer cents. Mileage is miles (one decimal place) times the
//     rate (cents per mile, possibly half a cent), rounded half-up to the cent.
//     The arithmetic is done in integers so 0.2 mi x 72.5c is 15c, not 14.
//   * A computed route is rounded per leg, to 0.1 mi half-up.
//   * Miles for a Catering Event in the staff member's own car are the deal's
//     stored round-trip miles (Catering-Manager's deals.round_trip_miles), to
//     0.1 mi half-up; staff do not type them (the owner, 2026-11-16;
//     ruling 54). mileage_mode 'deal' (migration 58). Until the trip is Approved its miles follow the deal: priced on
//     every read from the deal's miles now, and written to the row by the
//     database on every write and at Approve (migration 58), so an Approved
//     trip pays the miles it was approved on. A deal with no round-trip miles
//     yet waits for them (ruling 51): milesPending, noMilesRefusal.
//
// migration_49.sql's travel_reimbursements_payable view is the database's
// copy of reimbursementCents(); migration_49_verify.sql,
// migration_50_verify.sql and migration_52_verify.sql check they agree.
//
// Pure (money() for the text is too), so `node --test` runs it and the browser
// can use it.

import type { AdjustmentField, ApproverAction } from "./lifecycle.ts";
import { money } from "../payroll/paySheet.ts";

export type MileageRate = {
  /** First trip date the rate applies to. YYYY-MM-DD. */
  starts_on: string;
  /** Cents per mile, e.g. 72.5. Postgres numeric may arrive as a string. */
  cents_per_mile: number;
};

/**
 * Where a Catering Event's cap comes from (deal_mileage_cap(), migrations 49,
 * 50 and 52), checked in this order:
 *   no_quote          the deal has no quote: no cap (the owner, 2026-10-29);
 *   uber_flat_fee     the quote charged the $50 Uber flat fee: no cap;
 *   no_rate_on_quote  the quote's transportation subtotal is $0: 0c, whatever
 *                     per-mile rate it stores (every quote stores one since
 *                     Catering-Manager #112; migration 52);
 *   quoted_rate       the per-mile rate the quote stored;
 *   quote_derived     the quote's transportation subtotal / the deal's
 *                     round-trip miles, to the half cent (quotes before the
 *                     rate was stored);
 *   no_miles_on_deal  the quote charged mileage but the deal has no
 *                     round-trip miles to divide it by: 0c until the miles
 *                     land (milesRecalc.ts; never more than the quote charged);
 *   no_rate_on_quote  any other quote: no mileage line, and no rate stored:
 *                     0c (the owner, 2026-10-29);
 *   none              no deal: no cap.
 */
export type CapBasis = "no_quote" | "uber_flat_fee" | "quoted_rate" | "quote_derived" | "no_miles_on_deal" | "no_rate_on_quote" | "none";

/**
 * A Catering Event's cap, as the database answers it. recalc_failed: for
 * 'no_miles_on_deal', a miles recalculation has finished and the deal still has
 * no miles (lib/reimbursements/milesRecalc.ts); absent when unknown.
 */
export type MileageCap = {
  cap_cents_per_mile: number | null;
  basis: CapBasis;
  recalc_failed?: boolean;
  /**
   * The deal's stored round-trip miles (deals.round_trip_miles), what a
   * Catering Event trip in the car is paid on (mileage_mode 'deal'); null
   * when the deal has none. Read with the service role: staff cannot read
   * deals (lib/reimbursements/server.ts, loadMileageCaps).
   */
  round_trip_miles?: number | null;
};

/**
 * How a trip's miles were given: typed by staff, computed from the stops they
 * entered (Groceries / errands), or the deal's stored round trip (a Catering
 * Event, the owner 2026-11-16; migration 58).
 */
export type MileageMode = "typed" | "destinations" | "deal";

/** The longest single trip anyone may type, in miles. */
export const MAX_MILES = 2000;

/** The largest toll or parking amount, in cents ($99,999.99). */
export const MAX_AMOUNT_CENTS = 9_999_999;

/** Meters in a statute mile. */
const METERS_PER_MILE = 1609.344;

/** The rate in effect on `tripDate`: the latest one starting on or before it. */
export function rateForDate(rates: MileageRate[], tripDate: string): MileageRate | null {
  let best: MileageRate | null = null;
  for (const r of rates) {
    if (r.starts_on <= tripDate && (!best || r.starts_on > best.starts_on)) best = r;
  }
  return best ? { starts_on: best.starts_on, cents_per_mile: Number(best.cents_per_mile) } : null;
}

/**
 * The rate a trip is paid at: the IRS rate for the trip date, or the cap when
 * it is lower. Null when no IRS rate covers the trip date (a cap alone does
 * not price it).
 */
export function rateForTrip(
  rates: MileageRate[],
  tripDate: string,
  cap: number | null | undefined,
): { cents_per_mile: number; capped: boolean } | null {
  const irs = rateForDate(rates, tripDate);
  if (!irs) return null;
  return cap != null && Number(cap) < irs.cents_per_mile
    ? { cents_per_mile: Number(cap), capped: true }
    : { cents_per_mile: irs.cents_per_mile, capped: false };
}

/**
 * Why a Catering Event's miles pay 0c, for staff and Approvers; null when the
 * cap is not 0c. Tolls and parking are paid either way.
 */
export function zeroCapText(cap: MileageCap | null | undefined): string | null {
  if (cap?.cap_cents_per_mile == null || Number(cap.cap_cents_per_mile) !== 0) return null;
  if (cap.basis !== "no_miles_on_deal") return "the Catering Event's quote charged the customer no mileage, so its miles are not reimbursed";
  return cap.recalc_failed
    ? "the Catering Event's quote charged mileage, but its deal has no round-trip miles to price it by; the automatic recalculation did not find them, so a manager should check the event's venue address, and the trip is repriced until it is paid"
    : "the Catering Event's quote charged mileage, but its deal has no round-trip miles to price it by yet; they are being recalculated automatically, and the trip is repriced until it is paid";
}

/**
 * "72.5¢/mi, what the event's quote charged", "76¢/mi, the IRS rate for the
 * trip date", or for a 0c cap the reason (zeroCapText), for the form's estimate.
 */
export function mileageRateText(a: Pick<Amounts, "rate" | "capped">, cap?: MileageCap | null): string {
  if (a.rate == null) return "no Mileage rate";
  const zero = a.capped ? zeroCapText(cap) : null;
  if (zero) return `${a.rate}¢/mi: ${zero}`;
  return `${a.rate}¢/mi, ${a.capped ? "what the Catering Event's quote charged per mile (below the IRS rate)" : "the IRS rate for the trip date"}`;
}

/**
 * A deal's stored round-trip miles (double precision, e.g. 6.43) as the miles
 * a trip is paid on: 0.1 mi half-up, as migration 58 stores them; 0 when the
 * deal has none.
 */
export function dealMiles(roundTrip: number | string | null | undefined): number {
  const m = Number(roundTrip);
  if (!(m > 0)) return 0;
  // The epsilon keeps an exact half (6.25) from falling to floating error.
  return Math.floor(m * 10 + 0.5 + 1e-9) / 10;
}

/** What milesPending reads of a trip. */
type MilesOf = { mileage_mode?: MileageMode | string; miles: number | string; mileage_cap?: MileageCap | null };

/**
 * Whether a Catering Event trip's mileage is waiting on its deal's round-trip
 * miles (ruling 51), so it may not be approved or paid yet:
 *   'deal' miles (the owner, 2026-11-16): the deal has no round-trip miles,
 *     unless its quote charged $0 mileage ('no_rate_on_quote'), which pays 0c
 *     a mile whatever the miles (ruling 50);
 *   typed or destination miles (a trip already Approved when migration 58
 *     ran, kept typed even if sent back since): the quote charged mileage but
 *     the deal has no round-trip miles to price them by ('no_miles_on_deal').
 */
export function milesPending(r: MilesOf): boolean {
  if (r.mileage_mode === "deal") return !(Number(r.miles) > 0) && r.mileage_cap?.basis !== "no_rate_on_quote";
  return r.mileage_cap?.basis === "no_miles_on_deal" && Number(r.miles) > 0;
}

/**
 * For staff: a Catering Event's mileage while its deal has no round-trip
 * miles yet, in words a new hire knows.
 */
export function pendingMilesText(cap: MileageCap | null | undefined): string {
  return cap?.recalc_failed
    ? "Mileage for this event: the round-trip miles could not be found automatically, so a manager will check the event's address. Your mileage is added once the miles are in."
    : "Mileage for this event: the round-trip miles are not in yet. They are being looked up automatically, and your mileage is added once they are in.";
}

/**
 * The read-only Mileage line on the form for a Catering Event in the staff
 * member's own car: "Mileage for this event: 6.4 miles round trip, $4.64".
 * The miles are the deal's (dealMiles of cap.round_trip_miles), at the lower
 * of the IRS rate for the trip date and what the event's quote charged a mile.
 */
export function eventMileageText(cap: MileageCap | null | undefined, tripDate: string, rates: MileageRate[]): string {
  const miles = dealMiles(cap?.round_trip_miles);
  if (milesPending({ mileage_mode: "deal", miles, mileage_cap: cap })) return pendingMilesText(cap);
  const a = reimbursementCents(
    { trip_date: tripDate, miles, tolls_cents: 0, parking_cents: 0, mileage_cents_override: null, cap_cents_per_mile: cap?.cap_cents_per_mile ?? null },
    rates,
  );
  const head = `Mileage for this event: ${miles.toFixed(1)} miles round trip`;
  if (a.mileage_cents == null) return `${head}. There is no Mileage rate for ${tripDate}.`;
  if (cap?.basis === "no_rate_on_quote") return `${head}, ${money(0)}. The event's quote charged the customer no mileage, so mileage is not paid back.`;
  return `${head}, ${money(a.mileage_cents)}`;
}

/** Miles x cents-per-mile, half-up to the cent, in integers. */
export function mileageCents(miles: number, centsPerMile: number): number {
  const tenths = Math.round(miles * 10);
  const hundredthsOfCent = Math.round(Number(centsPerMile) * 100);
  // tenths of a mile x hundredths of a cent = thousandths of a cent.
  return Math.floor((tenths * hundredthsOfCent + 500) / 1000);
}

export type Priceable = {
  trip_date: string;
  miles: number | string;
  tolls_cents: number;
  parking_cents: number;
  /** An Adjustment's replacement for the mileage amount, or null. */
  mileage_cents_override: number | null;
  /**
   * The most a mile may pay: what the trip's Catering Event quote charged the
   * customer per mile, in cents (lib/reimbursements/server.ts asks the
   * database). 0 when the quote charged no mileage. Null or absent: no cap
   * (errands, the Uber flat fee, no quote).
   */
  cap_cents_per_mile?: number | null;
};

export type Amounts = {
  /** Cents per mile the trip is paid at; null when no IRS rate covers its date. */
  rate: number | null;
  /** The rate is the event quote's, lower than the IRS rate. */
  capped: boolean;
  /** Null when there is no rate and no Adjustment to price the miles. */
  mileage_cents: number | null;
  tolls_cents: number;
  parking_cents: number;
  total_cents: number | null;
};

/** What a reimbursement pays, at the rate for its trip (rateForTrip). */
export function reimbursementCents(r: Priceable, rates: MileageRate[]): Amounts {
  const rate = rateForTrip(rates, r.trip_date, r.cap_cents_per_mile);
  const mileage =
    r.mileage_cents_override != null
      ? r.mileage_cents_override
      : rate
        ? mileageCents(Number(r.miles), rate.cents_per_mile)
        : null;
  return {
    rate: rate ? rate.cents_per_mile : null,
    capped: rate?.capped ?? false,
    mileage_cents: mileage,
    tolls_cents: r.tolls_cents,
    parking_cents: r.parking_cents,
    total_cents: mileage == null ? null : mileage + r.tolls_cents + r.parking_cents,
  };
}

/**
 * A typed dollar amount ("12.50", "$4", 19.99) as integer cents. Blank is 0.
 * Null when it is not an amount: negative, more than two decimals, or more
 * than MAX_AMOUNT_CENTS.
 */
export function centsFromDollars(input: unknown): number | null {
  if (input == null) return 0;
  const text = typeof input === "number" ? input.toFixed(2) : String(input).trim();
  if (text === "") return 0;
  const m = /^\$?\s*(\d{1,5})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents <= MAX_AMOUNT_CENTS ? cents : null;
}

/** Typed miles, at most one decimal place and MAX_MILES. Null when not miles. */
export function milesFromInput(input: unknown): number | null {
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  if (!/^\d{1,4}(\.\d)?$/.test(text)) return null;
  const miles = Number(text);
  return miles <= MAX_MILES ? miles : null;
}

/** One route leg's length in miles, rounded to 0.1 mi half-up. */
export function legMiles(meters: number): number {
  // The epsilon keeps an exact half (0.05 mi) from falling to floating error.
  return Math.floor((meters * 10) / METERS_PER_MILE + 0.5 + 1e-9) / 10;
}

/** The sum of rounded legs, kept to one decimal place. */
export function sumMiles(legs: number[]): number {
  return Math.round(legs.reduce((s, m) => s + Math.round(m * 10), 0)) / 10;
}

// ---------- Adjustments and approval, as the Approver and staff see them -------------------

/** What an Adjustment records, as far as the amounts go. */
export type AdjustmentAmounts = { field: AdjustmentField; old_cents: number; new_cents: number; adjusted_at: string };

/** The amounts before the Adjustments that still stand, and which of them those Adjustments changed. */
export type BeforeAdjustments = { before: Amounts; adjusted: AdjustmentField[] };

/**
 * The amounts as they were before any Adjustment that still stands, so an
 * adjusted amount reads old -> new ("$16.72 -> $12.16 (adjusted)", ruling 40)
 * rather than a sum that does not add up. Mileage before is the miles at the
 * trip's rate; tolls or parking before is the first Adjustment's old
 * amount. An amount staff have retyped since (an edit drops a Mileage
 * Adjustment, or replaces tolls) is not adjusted. Null when nothing is.
 */
export function amountsBeforeAdjustments(
  r: Priceable,
  adjustments: AdjustmentAmounts[],
  rates: MileageRate[],
): BeforeAdjustments | null {
  const of = (field: AdjustmentField) => adjustments.filter((a) => a.field === field).sort((a, b) => a.adjusted_at.localeCompare(b.adjusted_at));
  const adjusted: AdjustmentField[] = [];
  if (r.mileage_cents_override != null && of("mileage").length) adjusted.push("mileage");
  const firstOld = (field: Exclude<AdjustmentField, "mileage">, now: number): number => {
    const list = of(field);
    if (!list.length || list[list.length - 1].new_cents !== now) return now;
    adjusted.push(field);
    return list[0].old_cents;
  };
  const tolls = firstOld("tolls", r.tolls_cents);
  const parking = firstOld("parking", r.parking_cents);
  if (!adjusted.length) return null;
  return { before: reimbursementCents({ ...r, tolls_cents: tolls, parking_cents: parking, mileage_cents_override: null }, rates), adjusted };
}

/** What decideRefusal and noMilesRefusal read of a reimbursement: its amounts, miles, how they were given, and cap. */
export type Approvable = Pick<Priceable, "trip_date" | "miles" | "mileage_cents_override"> & {
  amounts: Pick<Amounts, "total_cents">;
  mileage_mode?: MileageMode | string;
  mileage_cap?: MileageCap | null;
};

/**
 * Why a Catering Event trip may not be approved or paid yet, or null: its
 * mileage is waiting on the deal's round-trip miles (milesPending; the owner,
 * 2026-10-29: never pay a 0c trip by mistake; "just recalculate miles"; and
 * 2026-11-16: a trip in the car is paid the deal's round trip). The miles are
 * recalculated automatically (./milesRecalc.ts); when one has finished
 * without finding them, a manager should check the venue address. `next` is
 * the step once they are in, e.g. "approve it". Not refused: a typed trip
 * with no miles (only tolls or parking, which the cap does not touch), a
 * Mileage Adjustment, which an Approver made with evidence and which replaces
 * the amount, or a quote that charged no mileage ('no_rate_on_quote', 0c on
 * purpose).
 */
export function noMilesRefusal(r: Approvable, next: string): string | null {
  if (r.mileage_cents_override != null || !milesPending(r)) return null;
  const why =
    r.mileage_mode === "deal"
      ? "Its Catering Event's deal has no round-trip miles yet, so its mileage cannot be priced."
      : "Its Catering Event's quote charged mileage, but the deal has no round-trip miles, so its miles pay 0¢.";
  return r.mileage_cap?.recalc_failed
    ? `${why} The automatic recalculation did not find them, so a manager should check the venue address on the deal; once the miles are in, ${next}.`
    : `${why} They are being recalculated automatically; once they are in, ${next}.`;
}

/**
 * Why the decide route refuses this action on a reimbursement, or null when
 * it does not. approve: with no Mileage rate for its trip date it has no
 * total (ruling 42); and a Catering Event whose deal has no round-trip miles
 * prices its miles at 0c until they are recalculated (noMilesRefusal), which also
 * refuses paid_outside_payroll. The other actions are never refused here.
 * The queue disables the same buttons with the same words.
 */
export function decideRefusal(action: ApproverAction, r: Approvable): string | null {
  if (action === "paid_outside_payroll") return noMilesRefusal(r, "mark it Paid outside payroll");
  if (action !== "approve") return null;
  if (r.amounts.total_cents == null)
    return `There is no Mileage rate for ${r.trip_date}, so it has no total and cannot be approved. Add the IRS rate for that date first.`;
  return noMilesRefusal(r, "approve it");
}

/** One of the amounts, by Adjustment field: as it stands, or as it was before (rulings 40, 43). Null: Mileage with no rate. */
export function fieldCents(amounts: Amounts, field: AdjustmentField): number | null {
  return field === "mileage" ? amounts.mileage_cents : field === "tolls" ? amounts.tolls_cents : amounts.parking_cents;
}

/** Cents as an input's dollars, "16.72"; blank for none. centsFromDollars reads it back. */
export function dollarsText(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

/** Amounts as shown, with what they were before the Adjustments that still stand. */
type Shown = { amounts: Amounts; before_adjustments: BeforeAdjustments | null };

/** One amount as staff and Approvers read it: "$a", or "$before → $now (adjusted)" when adjusted (ruling 40). */
export function amountText(r: Shown, field: AdjustmentField): string {
  const now = money(fieldCents(r.amounts, field));
  const b = r.before_adjustments;
  if (!b || !b.adjusted.includes(field)) return now;
  return `${money(fieldCents(b.before, field))} → ${now} (adjusted)`;
}

/** The total as read: "$a", or "$before → $now" when anything was adjusted (ruling 40). */
export function totalText(r: Shown): string {
  const now = money(r.amounts.total_cents);
  return r.before_adjustments ? `${money(r.before_adjustments.before.total_cents)} → ${now}` : now;
}
