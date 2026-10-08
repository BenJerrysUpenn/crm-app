// The money of a Travel Reimbursement (bj-finance #210).
//
//   * Mileage rate: the IRS business standard mileage rate in effect on the
//     trip date (rulings 27, 33). The rates live in public.mileage_rates
//     (migration 37), one row per start date, added by hand when the IRS
//     announces a new one (ruling 38). Every reimbursement not yet Paid is
//     priced at its trip date's rate whenever it is read: nothing is frozen at
//     submit, so a rate typed in late still reaches every unpaid item.
//   * Money is integer cents. Mileage is miles (one decimal place) times the
//     rate (cents per mile, possibly half a cent), rounded half-up to the cent.
//     The arithmetic is done in integers so 0.2 mi x 72.5c is 15c, not 14.
//   * A computed route is rounded per leg, to 0.1 mi half-up.
//
// migration_37.sql's travel_reimbursements_payable view is the database's
// copy of reimbursementCents(); migration_37_verify.sql checks they agree.
//
// Pure and dependency-free, so `node --test` runs it and the browser can use it.

export type MileageRate = {
  /** First trip date the rate applies to. YYYY-MM-DD. */
  starts_on: string;
  /** Cents per mile, e.g. 72.5. Postgres numeric may arrive as a string. */
  cents_per_mile: number;
};

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
};

export type Amounts = {
  /** Cents per mile on the trip date; null when no rate covers it. */
  rate: number | null;
  /** Null when there is no rate and no Adjustment to price the miles. */
  mileage_cents: number | null;
  tolls_cents: number;
  parking_cents: number;
  total_cents: number | null;
};

/** What a reimbursement pays, at the rate for its trip date. */
export function reimbursementCents(r: Priceable, rates: MileageRate[]): Amounts {
  const rate = rateForDate(rates, r.trip_date);
  const mileage =
    r.mileage_cents_override != null
      ? r.mileage_cents_override
      : rate
        ? mileageCents(Number(r.miles), rate.cents_per_mile)
        : null;
  return {
    rate: rate ? rate.cents_per_mile : null,
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

export type AmountField = "mileage" | "tolls" | "parking";

/** What an Adjustment records, as far as the amounts go. */
export type AdjustmentAmounts = { field: AmountField; old_cents: number; new_cents: number; adjusted_at: string };

/**
 * The amounts as they were before any Adjustment that still stands, so an
 * adjusted amount reads old -> new ("$16.72 -> $12.16 (adjusted)", ruling 40)
 * rather than a sum that does not add up. Mileage before is the miles at the
 * trip date's rate; tolls or parking before is the first Adjustment's old
 * amount. An amount staff have retyped since (an edit drops a Mileage
 * Adjustment, or replaces tolls) is not adjusted. Null when nothing is.
 */
export function amountsBeforeAdjustments(
  r: Priceable,
  adjustments: AdjustmentAmounts[],
  rates: MileageRate[],
): { before: Amounts; adjusted: AmountField[] } | null {
  const of = (field: AmountField) => adjustments.filter((a) => a.field === field).sort((a, b) => a.adjusted_at.localeCompare(b.adjusted_at));
  const adjusted: AmountField[] = [];
  if (r.mileage_cents_override != null && of("mileage").length) adjusted.push("mileage");
  const firstOld = (field: "tolls" | "parking", now: number): number => {
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

/**
 * Why a reimbursement cannot be approved, or null when it can: with no
 * Mileage rate for its trip date it has no total (ruling 42). The decide
 * route refuses the same.
 */
export function approveRefusal(amounts: Pick<Amounts, "total_cents">, tripDate: string): string | null {
  return amounts.total_cents == null
    ? `There is no Mileage rate for ${tripDate}, so it has no total and cannot be approved. Add the IRS rate for that date first.`
    : null;
}

/** One amount as it stands, for the Adjust panel (ruling 43). Null: Mileage with no rate. */
export function currentFieldCents(amounts: Amounts, field: AmountField): number | null {
  return field === "mileage" ? amounts.mileage_cents : field === "tolls" ? amounts.tolls_cents : amounts.parking_cents;
}

/** Cents as an input's dollars, "16.72"; blank for none. centsFromDollars reads it back. */
export function dollarsText(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}
