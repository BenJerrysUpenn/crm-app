// Labor vs target (bj-finance #696, spec by Alina 2026-10-13, rulings
// 2026-10-16): for a chosen month, each Sunday-to-Saturday week that starts
// in it, with what was sold, what in-store hourly labor actually cost all-in
// and how far that sits from the all-in target.
//
//   Actual sales          in-store sales, public.sales_daily_in_store
//                         (migration 41), all seven days. Catering sales are
//                         never in it.
//   Catering offset       each day's booked catering deals: the crew hours the
//                         client paid for (labor_hours x staff_count) at crew
//                         cost + premium, exactly as the Schedule page's labor
//                         line prices them (cateringOffset in
//                         controlBoard/schedule.ts, reused, not re-derived).
//                         "We are simply taking out all catering labor by
//                         canceling it out with what the client paid for."
//   Actual hourly labor $ ALL-IN: wages + catering premium + solo close, as
//                         QBO paid them (public.labor_daily_actuals,
//                         migration 46: hourly, non-overhead staff, a pay
//                         period's dollars spread over its days by hours),
//                         less that day's catering offset, plus employer taxes
//                         and workers' comp on what is left at the control
//                         board's hourly rate in force on the day (FICA + FUTA
//                         + PA UC + WC, no caps: the board's hourlyLoad).
//   Actual %              actual hourly labor $ / actual sales.
//   Target %              ALL-IN: the board's all-in hourly goal in force on
//                         each day (hourlyAllInPct: hourly wages plus their
//                         taxes and comp as a share of sales, i.e. the payroll
//                         target less fixed payroll; computeBoard, the same
//                         number the Targets tab shows, not re-derived here).
//                         "Taxes on both sides" (Alina, 2026-10-16). With the
//                         week's sales it is sales-weighted over the days;
//                         without them it shows only when it is the same all
//                         week.
//   Variance $            actual hourly labor $ - target % x actual sales.
//                         Above zero is over target.
//   Variance hours        variance $ at the week's own in-store cost per hour
//                         (actual hourly labor $ / (hours paid - catering
//                         crew hours billed)).
//
// Every board value is the one in force on the day, so a past week is judged
// by the board as it stood then: a pay rule before its first row paid nothing
// (ruleOn), and fixed payroll counts only the people salaried that day
// (inFixedPayroll). A deal billed zero crew hours (a pickup) offsets nothing.
//
// A week counts only when it is over and all seven of its days have a
// labor_daily_actuals row; otherwise its labor is not available, never zero.
// The same for sales: a missing day makes the week's sales not available, and
// a catering offset that cannot be priced makes the week's labor not
// available. Nothing is estimated from punches or the schedule.
//
// Pure, so `node --test` runs it.

import { boardOn } from "../controlBoard/board.ts";
import type { Derived } from "../controlBoard/math.ts";
import type { SalaryRow, SettingRow } from "../controlBoard/settings.ts";
import type { SalariedProfile } from "../controlBoard/load.ts";
import { cateringOffset, type CateringBooking, type CateringOffsetInput, type LaborPerson, type LaborShift } from "../controlBoard/schedule.ts";
import { addDays, addMonths, eachDay, monthEnd } from "./dates.ts";

/** A row of public.labor_daily_actuals, as the card reads it. */
export type LaborDayRow = { day: string; hours: number; wages: number; catering_premium: number; solo_close: number };
/** A row of public.sales_daily_in_store, as the card reads it. */
export type SalesDayRow = { day: string; in_store: number };

export type LaborTargetInputs = {
  today: string;
  labor: LaborDayRow[];
  sales: SalesDayRow[];
  /** Every control_settings and profile_salaries row (all dates), and everyone in fixed payroll. */
  settings: SettingRow[];
  salaries: SalaryRow[];
  salaried: SalariedProfile[];
  /**
   * For the catering offset, as the Schedule page reads it: the booked deals
   * with their billed crew hours (null when they could not be read), the
   * Catering shifts that crew them, and everyone on the Team page.
   */
  catering: { bookings: CateringBooking[] | null; shifts: LaborShift[]; people: LaborPerson[] };
};

export type LaborTargetWeek = {
  /** Sunday. */
  start: string;
  /** Saturday. */
  end: string;
  /** Labor, sales and target all known: every column has a number. */
  available: boolean;
  /** Why something in the row is not available, in words. */
  why: string[];
  sales: number | null;
  /** Hours paid, catering crew included. */
  hours: number | null;
  wages: number | null;
  premium: number | null;
  solo: number | null;
  /** Crew hours billed on the week's booked catering deals. */
  cateringHours: number | null;
  /** What those billed hours cost all-in (crew cost + premium + taxes and comp); taken off the actual. */
  cateringOffset: number | null;
  /** Employer taxes and comp on the in-store hourly pay (after the catering offset). */
  taxesWc: number | null;
  /** All-in in-store hourly labor $. */
  actual: number | null;
  actualPct: number | null;
  /** The board's all-in hourly goal when it is the same all week. */
  allInGoalPct: Derived;
  /** The all-in target for the week (sales-weighted over its days). */
  targetPct: Derived;
  targetDollars: number | null;
  varianceDollars: number | null;
  varianceHours: number | null;
};

export type LaborTargetMonth = { month: string; weeks: LaborTargetWeek[] };

/** How many months the card offers: this one and the 11 before it. */
export const LABOR_MONTHS = 12;

/** The months on offer on `today`, newest first, as "YYYY-MM". */
export function laborMonths(today: string): string[] {
  return Array.from({ length: LABOR_MONTHS }, (_, i) => addMonths(today, -i).slice(0, 7));
}

/** The month a new card shows: the last full month. */
export function defaultLaborMonth(today: string): string {
  return addMonths(today, -1).slice(0, 7);
}

/** The Sundays of `month` ("YYYY-MM"): each starts one of its weeks. */
export function monthWeeks(month: string): string[] {
  const first = `${month}-01`;
  const dow = new Date(`${first}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const out: string[] = [];
  for (let d = addDays(first, (7 - dow) % 7); d <= monthEnd(first); d = addDays(d, 7)) out.push(d);
  return out;
}

/** The days the card can need on `today`: from the first Sunday of the oldest month on offer to the last Saturday of this one. */
export function laborWindow(today: string): { from: string; to: string } {
  const months = laborMonths(today);
  const last = monthWeeks(months[0]);
  return { from: monthWeeks(months[months.length - 1])[0], to: addDays(last[last.length - 1], 6) };
}

const missing = (...needs: string[]): Derived => ({ value: null, needs: [...new Set(needs)] });
const known = (value: number): Derived => ({ value, needs: [] });
const same = (a: number, b: number) => Math.abs(a - b) < 1e-12;

export const WHY = {
  notOver: "the week is not over yet",
  rates: "payroll tax and workers' comp rates not set on the control board",
  labor: (n: number) => `hourly payroll on file for ${n} of 7 days`,
  sales: (n: number) => `in-store sales on file for ${n} of 7 days`,
  varying: "the week's sales (the target changed during the week)",
  noInStoreHours: "no in-store hours left once the catering crew's billed hours are taken off",
  noInStoreLabor: "hourly labor is zero or less once the catering crew's billed hours are taken off",
} as const;

function week(
  start: string,
  i: LaborTargetInputs,
  labor: Map<string, LaborDayRow>,
  sales: Map<string, number>,
  offsetInput: CateringOffsetInput,
): LaborTargetWeek {
  const days = eachDay(start, addDays(start, 6));
  const end = days[6];
  const over = end < i.today;
  const why: string[] = [];
  if (!over) why.push(WHY.notOver);

  // The board in force on each day: the all-in hourly goal and the hourly tax and comp rate.
  const boards = days.map((d) => boardOn(d, i.settings, i.salaries, i.salaried));
  const goals = boards.map((b) => b.hourlyAllInPct);
  const loads = boards.map((b) => b.hourlyLoad);

  // Each day's catering offset, priced as the schedule prices it.
  const offsets = days.map((d) => cateringOffset(offsetInput, d));
  const offsetNeeds = [...new Set(offsets.flatMap((o) => [...o.hours.needs, ...o.dollars.needs]))];

  // Actual labor: all seven days paid and on file, and the week over.
  const laborRows = days.map((d) => labor.get(d));
  const laborDays = laborRows.filter(Boolean).length;
  if (over && laborDays < 7) why.push(WHY.labor(laborDays));
  let hours: number | null = null;
  let wages: number | null = null;
  let premium: number | null = null;
  let solo: number | null = null;
  let taxesWc: number | null = null;
  let cateringHours: number | null = null;
  let cateringDollars: number | null = null;
  let cateringAllIn: number | null = null;
  if (over) why.push(...offsetNeeds);
  if (over && laborDays === 7) {
    const rows = laborRows as LaborDayRow[];
    hours = rows.reduce((a, r) => a + r.hours, 0);
    wages = rows.reduce((a, r) => a + r.wages, 0);
    premium = rows.reduce((a, r) => a + r.catering_premium, 0);
    solo = rows.reduce((a, r) => a + r.solo_close, 0);
    const ratesSet = loads.every((l) => l.value != null);
    if (!ratesSet) why.push(WHY.rates);
    if (ratesSet && !offsetNeeds.length) {
      const off = offsets.map((o) => o.dollars.value!);
      cateringHours = offsets.reduce((a, o) => a + o.hours.value!, 0);
      cateringDollars = off.reduce((a, v) => a + v, 0);
      cateringAllIn = off.reduce((a, v, k) => a + v * (1 + loads[k].value!), 0);
      taxesWc = rows.reduce((a, r, k) => a + (r.wages + r.catering_premium + r.solo_close - off[k]) * loads[k].value!, 0);
    }
  }
  const actual =
    wages != null && premium != null && solo != null && cateringDollars != null && taxesWc != null
      ? wages + premium + solo - cateringDollars + taxesWc
      : null;

  // Sales: all seven days on file, and the week over.
  const salesDays = days.filter((d) => sales.has(d)).length;
  if (over && salesDays < 7) why.push(WHY.sales(salesDays));
  const weekSales = over && salesDays === 7 ? days.reduce((a, d) => a + sales.get(d)!, 0) : null;

  // The target: each day's sales at that day's target, or one % when it held all week.
  const targetNeeds = [...new Set(goals.flatMap((g) => g.needs))];
  let targetPct: Derived;
  let targetDollars: number | null = null;
  if (targetNeeds.length) targetPct = missing(...targetNeeds);
  else if (weekSales != null && weekSales > 0) {
    targetDollars = days.reduce((a, d, k) => a + sales.get(d)! * goals[k].value!, 0);
    targetPct = known(targetDollars / weekSales);
  } else if (goals.every((g) => same(g.value!, goals[0].value!))) targetPct = known(goals[0].value!);
  else targetPct = missing(WHY.varying);
  const allInGoalPct: Derived = targetNeeds.length
    ? missing(...targetNeeds)
    : goals.every((g) => same(g.value!, goals[0].value!))
      ? known(goals[0].value!)
      : missing(WHY.varying);

  const actualPct = actual != null && weekSales != null && weekSales > 0 ? actual / weekSales : null;
  const varianceDollars = actual != null && targetDollars != null ? actual - targetDollars : null;
  const inStoreHours = hours != null && cateringHours != null ? hours - cateringHours : null;
  if (actual != null && inStoreHours != null && !(inStoreHours > 0)) why.push(WHY.noInStoreHours);
  else if (actual != null && inStoreHours != null && !(actual > 0)) why.push(WHY.noInStoreLabor);
  const varianceHours =
    varianceDollars != null && inStoreHours != null && inStoreHours > 0 && actual! > 0 ? varianceDollars / (actual! / inStoreHours) : null;

  return {
    start,
    end,
    available: varianceHours != null,
    why,
    sales: weekSales,
    hours,
    wages,
    premium,
    solo,
    cateringHours,
    cateringOffset: cateringAllIn,
    taxesWc,
    actual,
    actualPct,
    allInGoalPct,
    targetPct,
    targetDollars,
    varianceDollars,
    varianceHours,
  };
}

/** The card's rows for `month` ("YYYY-MM"). */
export function laborVsTarget(month: string, i: LaborTargetInputs): LaborTargetMonth {
  const labor = new Map(i.labor.map((r) => [r.day, r]));
  const sales = new Map(i.sales.map((r) => [r.day, r.in_store]));
  const people = new Map(i.catering.people.map((p) => [p.id, p]));
  const offsetInput: CateringOffsetInput = {
    catering: i.catering.bookings,
    shifts: i.catering.shifts,
    people,
    settings: i.settings,
  };
  return { month, weeks: monthWeeks(month).map((start) => week(start, i, labor, sales, offsetInput)) };
}
