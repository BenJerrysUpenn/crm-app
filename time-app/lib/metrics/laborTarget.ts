// Labor vs target (bj-finance #696, spec by Alina 2026-10-13): for a chosen
// month, each Sunday-to-Saturday week that starts in it, with what was sold,
// what hourly labor actually cost and how far that sits from the target.
//
//   Actual sales          in-store sales, public.sales_daily_in_store
//                         (migration 41), all seven days.
//   Actual hourly labor $ wages + catering premium + solo close, as QBO paid
//                         them (public.labor_daily_actuals, migration 46:
//                         hourly, non-overhead staff, a pay period's dollars
//                         spread over its days by hours), plus employer taxes
//                         and workers' comp at the control board's hourly rate
//                         in force on each day (FICA + FUTA + PA UC + WC, no
//                         caps: the board's hourlyLoad).
//   Actual %              actual hourly labor $ / actual sales.
//   Target %              the board's hourly goal in force on each day (hourly
//                         wages as a share of sales, boardOn / computeBoard;
//                         not re-derived here), with the same day's taxes and
//                         comp on it, so it is on the same footing as the
//                         actual: goal x (1 + hourly load). With the week's
//                         sales it is sales-weighted over the days; without
//                         them it shows only when it is the same all week.
//   Variance $            actual hourly labor $ - target % x actual sales.
//                         Above zero is over target.
//   Variance hours        variance $ at the week's own cost per hour (actual
//                         hourly labor $ / actual hours).
//
// A week counts only when it is over and all seven of its days have a
// labor_daily_actuals row; otherwise its labor is not available, never zero.
// The same for sales: a missing day makes the week's sales not available.
// Nothing is estimated from punches or the schedule.
//
// Pure, so `node --test` runs it.

import { boardOn } from "../controlBoard/board.ts";
import type { Derived } from "../controlBoard/math.ts";
import type { SalaryRow, SettingRow } from "../controlBoard/settings.ts";
import type { SalariedProfile } from "../controlBoard/load.ts";
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
  hours: number | null;
  wages: number | null;
  premium: number | null;
  solo: number | null;
  taxesWc: number | null;
  actual: number | null;
  actualPct: number | null;
  /** The board's hourly goal (wages only) when it is the same all week. */
  hourlyGoalPct: Derived;
  /** The hourly goal with the hourly taxes and comp on it. */
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
} as const;

function week(start: string, i: LaborTargetInputs, labor: Map<string, LaborDayRow>, sales: Map<string, number>): LaborTargetWeek {
  const days = eachDay(start, addDays(start, 6));
  const end = days[6];
  const over = end < i.today;
  const why: string[] = [];
  if (!over) why.push(WHY.notOver);

  // The board in force on each day: the hourly goal and the hourly tax and comp rate.
  const boards = days.map((d) => boardOn(d, i.settings, i.salaries, i.salaried));
  const goals = boards.map((b) => b.hourlyGoalPct);
  const loads = boards.map((b) => b.hourlyLoad);
  const loadedGoals: Derived[] = goals.map((g, k) =>
    g.value == null || loads[k].value == null ? missing(...g.needs, ...loads[k].needs) : known(g.value * (1 + loads[k].value!)),
  );

  // Actual labor: all seven days paid and on file, and the week over.
  const laborRows = days.map((d) => labor.get(d));
  const laborDays = laborRows.filter(Boolean).length;
  if (over && laborDays < 7) why.push(WHY.labor(laborDays));
  let hours: number | null = null;
  let wages: number | null = null;
  let premium: number | null = null;
  let solo: number | null = null;
  let taxesWc: number | null = null;
  if (over && laborDays === 7) {
    const rows = laborRows as LaborDayRow[];
    hours = rows.reduce((a, r) => a + r.hours, 0);
    wages = rows.reduce((a, r) => a + r.wages, 0);
    premium = rows.reduce((a, r) => a + r.catering_premium, 0);
    solo = rows.reduce((a, r) => a + r.solo_close, 0);
    if (loads.every((l) => l.value != null)) {
      taxesWc = rows.reduce((a, r, k) => a + (r.wages + r.catering_premium + r.solo_close) * loads[k].value!, 0);
    } else why.push(WHY.rates);
  }
  const actual = wages != null && premium != null && solo != null && taxesWc != null ? wages + premium + solo + taxesWc : null;

  // Sales: all seven days on file, and the week over.
  const salesDays = days.filter((d) => sales.has(d)).length;
  if (over && salesDays < 7) why.push(WHY.sales(salesDays));
  const weekSales = over && salesDays === 7 ? days.reduce((a, d) => a + sales.get(d)!, 0) : null;

  // The target: each day's sales at that day's target, or one % when it held all week.
  const targetNeeds = [...new Set(loadedGoals.flatMap((g) => g.needs))];
  let targetPct: Derived;
  let targetDollars: number | null = null;
  if (targetNeeds.length) targetPct = missing(...targetNeeds);
  else if (weekSales != null && weekSales > 0) {
    targetDollars = days.reduce((a, d, k) => a + sales.get(d)! * loadedGoals[k].value!, 0);
    targetPct = known(targetDollars / weekSales);
  } else if (loadedGoals.every((g) => same(g.value!, loadedGoals[0].value!))) targetPct = known(loadedGoals[0].value!);
  else targetPct = missing(WHY.varying);
  const hourlyGoalPct: Derived = goals.some((g) => g.value == null)
    ? missing(...goals.flatMap((g) => g.needs))
    : goals.every((g) => same(g.value!, goals[0].value!))
      ? known(goals[0].value!)
      : missing(WHY.varying);

  const actualPct = actual != null && weekSales != null && weekSales > 0 ? actual / weekSales : null;
  const varianceDollars = actual != null && targetDollars != null ? actual - targetDollars : null;
  const varianceHours = varianceDollars != null && hours != null && hours > 0 && actual! > 0 ? varianceDollars / (actual! / hours) : null;

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
    taxesWc,
    actual,
    actualPct,
    hourlyGoalPct,
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
  return { month, weeks: monthWeeks(month).map((start) => week(start, i, labor, sales)) };
}
