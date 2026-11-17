// Labor vs target (bj-finance #696, spec by Alina 2026-10-13, rulings
// 2026-10-16): for each Sunday-to-Saturday week on offer (weekRange.ts: from
// the first week under Withers to this one), what was sold, what in-store hourly labor actually cost all-in
// and how far that sits from the all-in target.
//
//   Actual sales          in-store sales, public.sales_daily_in_store
//                         (migration 41), all seven days. Catering sales are
//                         never in it.
//   Catering work         never in it (Alina, 2026-11-16: "catering shouldn't
//                         be affecting the labor percent because catering
//                         revenue covers that as a separate bill"). What comes
//                         off is the catering work the clocks recorded, as
//                         paid: each day's catering_hours and catering_wages
//                         (migration 59; bj-finance modules/labor_days.py:
//                         When I Work lines whose Position is Catering before
//                         the time app, punches on Catering shifts after, each
//                         person at their own paid rate) and the whole
//                         catering premium. Booked deals and the hours a quote
//                         billed are not read: a deal with no crew, a pickup
//                         or a drop-off, cannot change a week.
//   Marketing work        never in it either (Alina, 2026-11-16: marketing
//                         work is a separate marketing budget, taken out like
//                         catering, at the hours actually worked): each day's
//                         marketing_hours and marketing_wages (migration 60;
//                         modules/labor_days.py: punches on a Marketing shift
//                         or on any shift of a marketing deal, When I Work's
//                         Marketing position before the time app, each person
//                         at their own paid rate). Never the same hours as
//                         catering.
//   Actual hourly labor $ ALL-IN: wages + solo close as QBO paid them
//                         (public.labor_daily_actuals, migration 46: hourly,
//                         non-overhead staff, a pay period's dollars spread
//                         over its days by hours) less the day's catering
//                         and marketing wages, plus employer taxes and
//                         workers' comp on that
//                         at the control board's hourly rate in force on the
//                         day (FICA + FUTA + PA UC + WC, no caps: the board's
//                         hourlyLoad).
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
//                         and marketing hours worked)).
//
// Every board value is the one in force on the day, so a past week is judged
// by the board as it stood then: fixed payroll counts only the people salaried
// that day (inFixedPayroll).
//
// A week counts only when it is over and all seven of its days have a
// labor_daily_actuals row with its catering and marketing split; otherwise its labor is not
// available, never zero. The same for sales: a missing day makes the week's
// sales not available. Nothing is estimated from punches or the schedule.
//
// Pure, so `node --test` runs it.

import { boardOn } from "../controlBoard/board.ts";
import type { Derived } from "../controlBoard/math.ts";
import type { SalaryRow, SettingRow } from "../controlBoard/settings.ts";
import type { SalariedProfile } from "../controlBoard/load.ts";
import { addDays, eachDay } from "./dates.ts";
import { laborWeekStarts } from "./weekRange.ts";

/**
 * A row of public.labor_daily_actuals, as the card reads it. The catering
 * split (migration 59) and the marketing split (migration 60) are null on a
 * day bj-finance has not split yet.
 */
export type LaborDayRow = {
  day: string;
  hours: number;
  wages: number;
  catering_premium: number;
  solo_close: number;
  catering_hours: number | null;
  catering_wages: number | null;
  marketing_hours: number | null;
  marketing_wages: number | null;
};
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
  /** Hours paid, catering work included. */
  hours: number | null;
  /** Wages paid, catering work included. */
  wages: number | null;
  /** The catering premium paid: all catering, so none of it is in the actual. */
  premium: number | null;
  solo: number | null;
  /** Hours worked on catering, as the clocks recorded them. */
  cateringHours: number | null;
  /** What that catering work cost all-in (wages + premium + taxes and comp); not in the actual. */
  cateringOffset: number | null;
  /** Hours worked on marketing, as the clocks recorded them. */
  marketingHours: number | null;
  /** What that marketing work cost all-in (wages + taxes and comp); not in the actual. */
  marketingOffset: number | null;
  /** Employer taxes and comp on the in-store hourly pay. */
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

/** The days the card can need on `today`: from the first week on offer to the Saturday of this one. */
export function laborWindow(today: string): { from: string; to: string } {
  const starts = laborWeekStarts(today);
  return { from: starts[0], to: addDays(starts[starts.length - 1], 6) };
}

const missing = (...needs: string[]): Derived => ({ value: null, needs: [...new Set(needs)] });
const known = (value: number): Derived => ({ value, needs: [] });
const same = (a: number, b: number) => Math.abs(a - b) < 1e-12;

export const WHY = {
  notOver: "the week is not over yet",
  rates: "payroll tax and workers' comp rates not set on the control board",
  labor: (n: number) => `hourly payroll on file for ${n} of 7 days`,
  split: (unsplit: number) => `catering and marketing work not yet split out of the payroll for ${unsplit} of 7 days`,
  sales: (n: number) => `in-store sales on file for ${n} of 7 days`,
  varying: "the week's sales (the target changed during the week)",
  noInStoreHours: "no in-store hours left once the catering and marketing work is taken off",
  noInStoreLabor: "hourly labor is zero or less once the catering and marketing work is taken off",
} as const;

function week(
  start: string,
  i: LaborTargetInputs,
  labor: Map<string, LaborDayRow>,
  sales: Map<string, number>,
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
  let cateringWages: number | null = null;
  let cateringAllIn: number | null = null;
  let marketingHours: number | null = null;
  let marketingWages: number | null = null;
  let marketingAllIn: number | null = null;
  if (over && laborDays === 7) {
    const rows = laborRows as LaborDayRow[];
    hours = rows.reduce((a, r) => a + r.hours, 0);
    wages = rows.reduce((a, r) => a + r.wages, 0);
    premium = rows.reduce((a, r) => a + r.catering_premium, 0);
    solo = rows.reduce((a, r) => a + r.solo_close, 0);
    const split = rows.filter(
      (r) => r.catering_hours != null && r.catering_wages != null && r.marketing_hours != null && r.marketing_wages != null,
    ).length;
    if (split < 7) why.push(WHY.split(7 - split));
    const ratesSet = loads.every((l) => l.value != null);
    if (!ratesSet) why.push(WHY.rates);
    if (split === 7) {
      cateringHours = rows.reduce((a, r) => a + r.catering_hours!, 0);
      marketingHours = rows.reduce((a, r) => a + r.marketing_hours!, 0);
    }
    if (ratesSet && split === 7) {
      cateringWages = rows.reduce((a, r) => a + r.catering_wages!, 0);
      marketingWages = rows.reduce((a, r) => a + r.marketing_wages!, 0);
      cateringAllIn = rows.reduce((a, r, k) => a + (r.catering_wages! + r.catering_premium) * (1 + loads[k].value!), 0);
      marketingAllIn = rows.reduce((a, r, k) => a + r.marketing_wages! * (1 + loads[k].value!), 0);
      taxesWc = rows.reduce((a, r, k) => a + (r.wages - r.catering_wages! - r.marketing_wages! + r.solo_close) * loads[k].value!, 0);
    }
  }
  const actual =
    wages != null && solo != null && cateringWages != null && marketingWages != null && taxesWc != null
      ? wages - cateringWages - marketingWages + solo + taxesWc
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
  const inStoreHours = hours != null && cateringHours != null && marketingHours != null ? hours - cateringHours - marketingHours : null;
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
    marketingHours,
    marketingOffset: marketingAllIn,
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

/** The card's rows for the weeks starting on `starts` (Sundays). */
export function laborVsTarget(starts: string[], i: LaborTargetInputs): LaborTargetWeek[] {
  const labor = new Map(i.labor.map((r) => [r.day, r]));
  const sales = new Map(i.sales.map((r) => [r.day, r.in_store]));
  return starts.map((start) => week(start, i, labor, sales));
}
