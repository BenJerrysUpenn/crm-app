// Labor vs target (bj-finance #696, spec by Alina 2026-10-13; all labor
// against the payroll target, Alina 2026-11-18): for each Sunday-to-Saturday
// week on offer (weekRange.ts: from the first week under Withers to this
// one), what was sold, what all of the store's labor cost all-in, and how far
// that sits from the payroll target. It is the same test the Targets tab
// sets: total payroll (salaried and hourly, with taxes and comp) at the
// payroll target % of total sales.
//
//   Sales                 in-store + delivery + catering, each day:
//                           in-store  public.sales_daily_in_store.in_store
//                                     (migration 41: register and online
//                                     pickup);
//                           delivery  the same table's delivery (migration
//                                     61). The scoopers make the delivery
//                                     orders, so their sales count (Alina,
//                                     2026-11-18);
//                           catering  booked deals by event date, before
//                                     tax (catering.ts cateringByDay).
//                         A day with no in-store or no delivery figure on
//                         file makes the week's sales not available.
//   Hourly labor          wages + catering premium + solo close as QBO paid
//                         them (public.labor_daily_actuals, migration 46:
//                         hourly, non-overhead staff, a pay period's dollars
//                         spread over its days by hours), catering crews
//                         included, less the day's marketing wages (migration
//                         60), plus employer taxes and workers' comp at the
//                         control board's hourly rate in force on the day
//                         (FICA + FUTA + PA UC + WC, no caps: hourlyLoad).
//   Marketing work        never in it: marketing has its own budget (Alina,
//                         2026-11-16) and no sales of its own. Each day's
//                         marketing_hours and marketing_wages (modules/
//                         labor_days.py) come off at the hours worked.
//   Salaried labor        the board's fixed payroll in force on the day (the
//                         people salaried that day, inFixedPayroll: salary +
//                         employer taxes with caps + comp), a 365th a day.
//   Actual $              hourly labor + salaried labor.
//   Actual %              actual $ / sales.
//   Target %              the board's total payroll target in force on each
//                         day (target.payroll_pct), sales-weighted over the
//                         days; without the week's sales it shows only when
//                         it is the same all week.
//   Variance $            actual $ - target % x sales. Above zero is over.
//   Variance hours        variance $ at the week's own hourly cost per hour
//                         (hourly labor / hours paid less marketing hours):
//                         hourly hours are what the schedule can change.
//
// A week counts only when it is over and all seven of its days have a
// labor_daily_actuals row with its catering and marketing split, and sales
// on file; otherwise it is not available, never zero. Nothing is estimated
// from punches or the schedule.
//
// The same weeks feed weekly LER (feed.ts weeklyLer), with marketing work put
// back: LER is the whole business's labor.
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
/** A row of public.sales_daily_in_store, as the card reads it: delivery null when not on file. */
export type SalesDayRow = { day: string; in_store: number; delivery: number | null };

export type LaborTargetInputs = {
  today: string;
  labor: LaborDayRow[];
  sales: SalesDayRow[];
  /** Booked catering sales by event day (cateringByDay); a day with none is absent. */
  catering: Record<string, number>;
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
  /** In-store + delivery + catering. */
  sales: number | null;
  inStoreSales: number | null;
  deliverySales: number | null;
  cateringSales: number | null;
  /** Hours paid, catering and marketing work included. */
  hours: number | null;
  /** Hourly hours that count: hours paid less marketing hours. */
  hourlyHours: number | null;
  /** Hourly labor all-in (wages + premium + solo, less marketing, with taxes and comp). */
  hourly: number | null;
  /** Salaried labor all-in: the board's fixed payroll for the week's days. */
  salaried: number | null;
  /** Hours worked on catering, as the clocks recorded them (counted). */
  cateringHours: number | null;
  /** What that catering work cost all-in (wages + premium + taxes and comp); counted in hourly. */
  cateringCost: number | null;
  /** Hours worked on marketing, as the clocks recorded them. */
  marketingHours: number | null;
  /** What that marketing work cost all-in (wages + taxes and comp); not in the actual. */
  marketingOffset: number | null;
  /** All labor all-in: hourly + salaried. */
  actual: number | null;
  actualPct: number | null;
  /** The payroll target % when it is the same all week. */
  goalPct: Derived;
  /** The target for the week (sales-weighted over its days). */
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

/** Fixed payroll is a year's cost: a day carries a 365th of it. */
export const DAYS_A_YEAR = 365;

const missing = (...needs: string[]): Derived => ({ value: null, needs: [...new Set(needs)] });
const known = (value: number): Derived => ({ value, needs: [] });
const same = (a: number, b: number) => Math.abs(a - b) < 1e-12;
const sum = <T,>(xs: T[], f: (x: T, k: number) => number) => xs.reduce((a, x, k) => a + f(x, k), 0);

export const WHY = {
  notOver: "the week is not over yet",
  rates: "payroll tax and workers' comp rates not set on the control board",
  fixed: (needs: string[]) => `salaried payroll needs ${needs.join(", ")}`,
  labor: (n: number) => `hourly payroll on file for ${n} of 7 days`,
  split: (unsplit: number) => `catering and marketing work not yet split out of the payroll for ${unsplit} of 7 days`,
  sales: (n: number) => `in-store sales on file for ${n} of 7 days`,
  delivery: (n: number) => `delivery sales on file for ${n} of 7 days`,
  varying: "the week's sales (the target changed during the week)",
  noHourlyHours: "no hourly hours left once the marketing work is taken off",
  noHourlyLabor: "hourly labor is zero or less once the marketing work is taken off",
} as const;

function week(
  start: string,
  i: LaborTargetInputs,
  labor: Map<string, LaborDayRow>,
  sales: Map<string, SalesDayRow>,
): LaborTargetWeek {
  const days = eachDay(start, addDays(start, 6));
  const end = days[6];
  const over = end < i.today;
  const why: string[] = [];
  if (!over) why.push(WHY.notOver);

  // The board in force on each day: the payroll target, the hourly tax and comp rate, fixed payroll.
  const boards = days.map((d) => boardOn(d, i.settings, i.salaries, i.salaried));
  const goals = boards.map((b) => b.payrollTargetPct);
  const loads = boards.map((b) => b.hourlyLoad);
  const fixed = boards.map((b) => b.fixedPayroll);

  // Labor: all seven days paid and on file, split, and the week over.
  const laborRows = days.map((d) => labor.get(d));
  const laborDays = laborRows.filter(Boolean).length;
  if (over && laborDays < 7) why.push(WHY.labor(laborDays));
  let hours: number | null = null;
  let hourlyHours: number | null = null;
  let hourly: number | null = null;
  let salaried: number | null = null;
  let cateringHours: number | null = null;
  let cateringCost: number | null = null;
  let marketingHours: number | null = null;
  let marketingOffset: number | null = null;
  if (over && laborDays === 7) {
    const rows = laborRows as LaborDayRow[];
    hours = sum(rows, (r) => r.hours);
    const split = rows.filter(
      (r) => r.catering_hours != null && r.catering_wages != null && r.marketing_hours != null && r.marketing_wages != null,
    ).length;
    if (split < 7) why.push(WHY.split(7 - split));
    const ratesSet = loads.every((l) => l.value != null);
    if (!ratesSet) why.push(WHY.rates);
    const fixedNeeds = [...new Set(fixed.flatMap((f) => f.needs))];
    if (fixedNeeds.length && ratesSet) why.push(WHY.fixed(fixedNeeds));
    if (split === 7) {
      cateringHours = sum(rows, (r) => r.catering_hours!);
      marketingHours = sum(rows, (r) => r.marketing_hours!);
      hourlyHours = hours - marketingHours;
    }
    if (ratesSet && split === 7) {
      const load = (k: number) => 1 + loads[k].value!;
      cateringCost = sum(rows, (r, k) => (r.catering_wages! + r.catering_premium) * load(k));
      marketingOffset = sum(rows, (r, k) => r.marketing_wages! * load(k));
      hourly = sum(rows, (r, k) => (r.wages - r.marketing_wages! + r.catering_premium + r.solo_close) * load(k));
    }
    if (!fixedNeeds.length) salaried = sum(fixed, (f) => f.value! / DAYS_A_YEAR);
  }
  const actual = hourly != null && salaried != null ? hourly + salaried : null;

  // Sales: in-store and delivery on file for all seven days, and the week over.
  const salesRows = days.map((d) => sales.get(d));
  const inStoreDays = salesRows.filter(Boolean).length;
  const deliveryDays = salesRows.filter((r) => r?.delivery != null).length;
  if (over && inStoreDays < 7) why.push(WHY.sales(inStoreDays));
  else if (over && deliveryDays < 7) why.push(WHY.delivery(deliveryDays));
  const salesKnown = over && deliveryDays === 7;
  const daySales = days.map((d, k) => (salesKnown ? salesRows[k]!.in_store + salesRows[k]!.delivery! + (i.catering[d] ?? 0) : 0));
  const inStoreSales = salesKnown ? sum(salesRows, (r) => r!.in_store) : null;
  const deliverySales = salesKnown ? sum(salesRows, (r) => r!.delivery!) : null;
  const cateringSales = salesKnown ? sum(days, (d) => i.catering[d] ?? 0) : null;
  const weekSales = salesKnown ? sum(daySales, (v) => v) : null;

  // The target: each day's sales at that day's target, or one % when it held all week.
  const targetNeeds = [...new Set(goals.flatMap((g) => g.needs))];
  const steady = !targetNeeds.length && goals.every((g) => same(g.value!, goals[0].value!));
  let targetPct: Derived;
  let targetDollars: number | null = null;
  if (targetNeeds.length) targetPct = missing(...targetNeeds);
  else if (weekSales != null && weekSales > 0) {
    targetDollars = sum(daySales, (v, k) => v * goals[k].value!);
    targetPct = known(targetDollars / weekSales);
  } else if (steady) targetPct = known(goals[0].value!);
  else targetPct = missing(WHY.varying);
  const goalPct: Derived = targetNeeds.length ? missing(...targetNeeds) : steady ? known(goals[0].value!) : missing(WHY.varying);

  const actualPct = actual != null && weekSales != null && weekSales > 0 ? actual / weekSales : null;
  const varianceDollars = actual != null && targetDollars != null ? actual - targetDollars : null;
  if (actual != null && hourlyHours != null && !(hourlyHours > 0)) why.push(WHY.noHourlyHours);
  else if (actual != null && hourlyHours != null && !(hourly! > 0)) why.push(WHY.noHourlyLabor);
  const varianceHours =
    varianceDollars != null && hourlyHours != null && hourlyHours > 0 && hourly! > 0 ? varianceDollars / (hourly! / hourlyHours) : null;

  return {
    start,
    end,
    available: varianceHours != null,
    why,
    sales: weekSales,
    inStoreSales,
    deliverySales,
    cateringSales,
    hours,
    hourlyHours,
    hourly,
    salaried,
    cateringHours,
    cateringCost,
    marketingHours,
    marketingOffset,
    actual,
    actualPct,
    goalPct,
    targetPct,
    targetDollars,
    varianceDollars,
    varianceHours,
  };
}

/** The card's rows for the weeks starting on `starts` (Sundays). */
export function laborVsTarget(starts: string[], i: LaborTargetInputs): LaborTargetWeek[] {
  const labor = new Map(i.labor.map((r) => [r.day, r]));
  const sales = new Map(i.sales.map((r) => [r.day, r]));
  return starts.map((start) => week(start, i, labor, sales));
}
