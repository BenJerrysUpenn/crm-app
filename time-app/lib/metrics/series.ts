// Chart-ready slices of the Metrics page's data for one widget's settings
// (bj-finance #671). Pure, so the arithmetic a chart shows is tested.
//
// Sales come per stream by day. Catering is in the CRM (by event date) and is
// live; in-store (with delivery) and concessions arrive with the finance feed.
// A stream with no data is `null`, never zero, and the whole-business view
// says which streams are still missing instead of comparing part of the
// business with the whole target.

import { addMonths, daysInMonth, eachDay, lastMonths, monthEnd, monthLabel, monthStart, shortDay } from "./dates.ts";
import { monthProgress, targetFor, STREAMS, type MonthProgress, type SalesTargetRow, type Stream, type StreamFilter } from "./targets.ts";

export type SalesStream = Exclude<Stream, "delivery">;
/** Sales by day per stream; a stream that is absent has no data yet. */
export type StreamDaily = Partial<Record<SalesStream, Record<string, number>>>;

const cents = (n: number) => Math.round(n * 100) / 100;

export function streamsIn(filter: StreamFilter): SalesStream[] {
  return filter === "all" ? [...STREAMS] : [filter as SalesStream];
}

export type SalesMtd = {
  labels: string[];
  days: string[];
  /** Cumulative actual per stream with data, null after the as-of day. */
  cumulative: { stream: SalesStream; values: (number | null)[] }[];
  /** Cumulative straight-line pace to the month's target. */
  pace: number[] | null;
  target: SalesTargetRow | null;
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
          run = cents(run + (sales[s]![d] ?? 0));
          return run;
        }),
      };
    });
  const target = targetFor(targets, month, stream);
  const n = daysInMonth(month);
  const pace = target ? days.map((_, i) => cents((target.amount * (i + 1)) / n)) : null;
  const actualSoFar = cents(cumulative.reduce((s, c) => s + (c.values[days.indexOf(asOf)] ?? 0), 0));
  const progress = waitingOn.length === 0 ? monthProgress({ target: target?.amount ?? null, actual: actualSoFar, asOf }) : null;
  return { labels: days.map(shortDay), days, cumulative, pace, target, progress, actualSoFar, waitingOn };
}

export type SalesMonths = {
  months: string[];
  labels: string[];
  actual: { stream: SalesStream; values: (number | null)[] }[];
  target: (number | null)[];
  provisional: boolean[];
  /** Index of the current month: later months are booked catering so far. */
  currentIndex: number;
  waitingOn: SalesStream[];
};

/** The last `back` months and `ahead` months to come: actual per stream against each month's target. */
export function salesByMonth(sales: StreamDaily, targets: SalesTargetRow[], stream: StreamFilter, asOf: string, back = 12, ahead = 3): SalesMonths {
  const months = [...lastMonths(asOf, back), ...Array.from({ length: ahead }, (_, i) => addMonths(asOf, i + 1))];
  const wanted = streamsIn(stream);
  const waitingOn = wanted.filter((s) => !sales[s]);
  const actual = wanted
    .filter((s) => sales[s])
    .map((s) => {
      const sums = new Map(months.map((m) => [m, 0]));
      for (const [day, v] of Object.entries(sales[s]!)) {
        const m = monthStart(day);
        if (sums.has(m)) sums.set(m, cents(sums.get(m)! + v));
      }
      // The feed's streams have nothing ahead of today; only catering is booked forward.
      return { stream: s, values: months.map((m) => (m > monthStart(asOf) && s !== "catering" ? null : sums.get(m)!)) };
    });
  const ts = months.map((m) => targetFor(targets, m, stream));
  return {
    months,
    labels: months.map(monthLabel),
    actual,
    target: ts.map((t) => t?.amount ?? null),
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
