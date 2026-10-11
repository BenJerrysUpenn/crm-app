// Chart-ready slices of the Metrics page's data for one widget's settings
// (bj-finance #671). Pure, so the arithmetic a chart shows is tested.
//
// Sales come per stream by day. Catering is in the CRM (by event date) and is
// live; in-store (with delivery) and concessions arrive with the finance feed.
// A stream with no data is `null`, never zero, and the whole-business view
// says which streams are still missing instead of comparing part of the
// business with the whole target.

import { addMonths, daysInMonth, eachDay, lastMonths, monthEnd, monthLabel, monthStart, shortDay } from "./dates.ts";
import { monthProgress, targetFor, STREAMS, STREAM_LABEL, type MonthProgress, type MonthTarget, type SalesTargetRow, type Stream, type StreamFilter } from "./targets.ts";
import { round2 } from "./round.ts";

/** Weeks of history the weekly widgets can show (their longest period). */
export const WEEKS = 13;
/** Months of history the monthly widgets can show. */
export const MONTHS = 12;
/** Months of booked catering ahead shown on the 12-month sales chart. */
export const MONTHS_AHEAD = 3;

export type SalesStream = Exclude<Stream, "delivery">;
/** Sales by day per stream; a stream that is absent has no data yet. */
export type StreamDaily = Partial<Record<SalesStream, Record<string, number>>>;

/** "catering and in-store and delivery": streams named in a sentence. */
export function streamNames(streams: SalesStream[]): string {
  return streams.map((s) => STREAM_LABEL[s].toLowerCase()).join(" and ");
}

export function streamsIn(filter: StreamFilter): SalesStream[] {
  return filter === "all" ? [...STREAMS] : [filter as SalesStream];
}

export type SalesMtd = {
  labels: string[];
  days: string[];
  /** Cumulative actual per stream with data, null after the as-of day. */
  cumulative: { stream: SalesStream; values: (number | null)[] }[];
  /**
   * Cumulative straight-line pace for the chart. While some streams wait on
   * the feed it is the pace for the streams that have data, so the chart
   * never sets part of the business against the whole target.
   */
  pace: number[] | null;
  paceLabel: string;
  /** The month's target for the stream chosen (the tiles). */
  target: MonthTarget | null;
  /** Month to date against target; null when a needed stream has no data. */
  progress: MonthProgress | null;
  /** Actual so far over the streams that have data. */
  actualSoFar: number;
  waitingOn: SalesStream[];
};

/** This month, day by day: cumulative sales per stream against the pace line. */
export function salesMonthToDate(sales: StreamDaily, targets: SalesTargetRow[], stream: StreamFilter, asOf: string): SalesMtd {
  const month = monthStart(asOf);
  const days = eachDay(month, monthEnd(month));
  const wanted = streamsIn(stream);
  const waitingOn = wanted.filter((s) => !sales[s]);
  const cumulative = wanted
    .filter((s) => sales[s])
    .map((s) => {
      let run = 0;
      return {
        stream: s,
        values: days.map((d) => {
          if (d > asOf) return null;
          run = round2(run + (sales[s]![d] ?? 0));
          return run;
        }),
      };
    });
  const target = targetFor(targets, month, stream);
  const n = daysInMonth(month);
  const have = cumulative.map((c) => c.stream);
  const partial = waitingOn.length > 0 && have.length > 0;
  const chartTarget = partial ? sumTargets(targets, month, have) : (target?.amount ?? null);
  const pace = chartTarget != null ? days.map((_, i) => round2((chartTarget * (i + 1)) / n)) : null;
  const paceLabel = partial ? `Pace to ${streamNames(have)} target` : "Pace to target";
  const actualSoFar = round2(cumulative.reduce((s, c) => s + (c.values[days.indexOf(asOf)] ?? 0), 0));
  const progress = waitingOn.length === 0 ? monthProgress({ target: target?.amount ?? null, actual: actualSoFar, asOf }) : null;
  return { labels: days.map(shortDay), days, cumulative, pace, paceLabel, target, progress, actualSoFar, waitingOn };
}

/** The sum of the month's targets for some streams; null when none is set. */
function sumTargets(targets: SalesTargetRow[], month: string, streams: SalesStream[]): number | null {
  const parts = streams.map((s) => targetFor(targets, month, s)).filter((t): t is MonthTarget => t != null);
  return parts.length ? round2(parts.reduce((a, t) => a + t.amount, 0)) : null;
}

export type SalesMonths = {
  months: string[];
  labels: string[];
  actual: { stream: SalesStream; values: (number | null)[] }[];
  /** The target line: for the streams with data while others wait on the feed. */
  target: (number | null)[];
  targetLabel: string;
  provisional: boolean[];
  /** Index of the current month: later months are booked catering so far. */
  currentIndex: number;
  waitingOn: SalesStream[];
};

/** The months the page loads (MONTHS back, MONTHS_AHEAD to come): actual per stream against each month's target. */
export function salesByMonth(sales: StreamDaily, targets: SalesTargetRow[], stream: StreamFilter, asOf: string): SalesMonths {
  const months = [...lastMonths(asOf, MONTHS), ...Array.from({ length: MONTHS_AHEAD }, (_, i) => addMonths(asOf, i + 1))];
  const wanted = streamsIn(stream);
  const waitingOn = wanted.filter((s) => !sales[s]);
  const actual = wanted
    .filter((s) => sales[s])
    .map((s) => {
      const sums = new Map(months.map((m) => [m, 0]));
      for (const [day, v] of Object.entries(sales[s]!)) {
        const m = monthStart(day);
        if (sums.has(m)) sums.set(m, round2(sums.get(m)! + v));
      }
      // The feed's streams have nothing ahead of today; only catering is booked forward.
      return { stream: s, values: months.map((m) => (m > monthStart(asOf) && s !== "catering" ? null : sums.get(m)!)) };
    });
  const ts = months.map((m) => targetFor(targets, m, stream));
  const have = actual.map((a) => a.stream);
  const partial = waitingOn.length > 0 && have.length > 0;
  return {
    months,
    labels: months.map(monthLabel),
    actual,
    target: partial ? months.map((m) => sumTargets(targets, m, have)) : ts.map((t) => t?.amount ?? null),
    targetLabel: partial ? `${have.map((h) => STREAM_LABEL[h]).join(" and ")} target` : "Target",
    provisional: ts.map((t) => Boolean(t?.provisional)),
    currentIndex: months.indexOf(monthStart(asOf)),
    waitingOn,
  };
}

/** The last `n` entries of a weekly or monthly list. */
export function lastN<T>(rows: T[], n: number): T[] {
  return rows.slice(Math.max(0, rows.length - n));
}

export function periodCount(period: string): number {
  const m = /^(\d+)([wmd])$/.exec(period);
  return m ? Number(m[1]) : 0;
}
