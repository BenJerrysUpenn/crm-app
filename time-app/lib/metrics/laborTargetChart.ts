// What the Labor vs target chart draws (bj-finance #696): one bar per
// Sunday-Saturday week of the chosen month for actual % (hourly labor all-in /
// in-store sales), the target % as a line across the weeks, and the month's
// totals over its complete weeks. Shapes the weeks laborTarget.ts works out;
// it works nothing out of its own beyond those sums.
//
// A week without its numbers has no bar (null, never zero) and is listed in
// `gaps` so the chart can mark it n/a. Only a complete week, one with sales,
// labor, target and variance all known, counts in the totals.

import { shortDay } from "./dates.ts";
import type { LaborTargetWeek } from "./laborTarget.ts";

export type LaborTargetTotals = {
  /** Weeks counted: every number known. */
  complete: number;
  /** Weeks in the month. */
  weeks: number;
  /** Sum of hourly labor all-in / sum of sales, complete weeks only; null with none. */
  actualPct: number | null;
  /** Sum of target $ / sum of sales: the target sales-weighted, as each week is. */
  targetPct: number | null;
  varianceDollars: number | null;
  varianceHours: number | null;
};

export type LaborTargetChartData = {
  /** The Sunday of each week, "Aug 2". */
  labels: string[];
  actualPct: (number | null)[];
  targetPct: (number | null)[];
  /** Indexes of weeks over target (variance $ above zero): drawn in the over colour. */
  over: number[];
  /** Indexes of weeks with no actual %: no bar, an n/a mark. */
  gaps: number[];
  totals: LaborTargetTotals;
};

function complete(w: LaborTargetWeek): boolean {
  return (
    w.available &&
    w.sales != null &&
    w.sales > 0 &&
    w.actual != null &&
    w.targetDollars != null &&
    w.varianceDollars != null
  );
}

export function laborTargetChart(weeks: LaborTargetWeek[]): LaborTargetChartData {
  const done = weeks.filter(complete);
  const sum = (f: (w: LaborTargetWeek) => number | null) => done.reduce((s, w) => s + (f(w) ?? 0), 0);
  const sales = sum((w) => w.sales);
  const any = done.length > 0;
  return {
    labels: weeks.map((w) => shortDay(w.start)),
    actualPct: weeks.map((w) => w.actualPct),
    targetPct: weeks.map((w) => w.targetPct.value),
    over: weeks.flatMap((w, i) => (w.actualPct != null && w.varianceDollars != null && w.varianceDollars > 0 ? [i] : [])),
    gaps: weeks.flatMap((w, i) => (w.actualPct == null ? [i] : [])),
    totals: {
      complete: done.length,
      weeks: weeks.length,
      actualPct: any ? sum((w) => w.actual) / sales : null,
      targetPct: any ? sum((w) => w.targetDollars) / sales : null,
      varianceDollars: any ? sum((w) => w.varianceDollars) : null,
      varianceHours: any && done.every((w) => w.varianceHours != null) ? sum((w) => w.varianceHours) : null,
    },
  };
}
