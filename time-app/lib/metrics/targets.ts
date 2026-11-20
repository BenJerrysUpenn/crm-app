// Sales targets and pace (bj-finance #671). A target is a row per calendar
// month and stream (public.sales_targets, migration 39): in-store (delivery
// included, as in the seller's Penn books), catering and concessions. The
// whole-business target for a month is the sum of its stream rows. A row can
// be marked provisional (the
// concessions rows are, until PAX sizing and gross vs net are ruled); the
// page says so wherever it is used.

import { daysInMonth } from "./dates.ts";
import { round2, round3 } from "./round.ts";

/** The streams a target or a filter names. Delivery sales are counted in in-store. */
export const STREAMS = ["in_store", "catering", "concessions"] as const;
export type Stream = (typeof STREAMS)[number] | "delivery";
export type StreamFilter = Stream | "all";

export const STREAM_LABEL: Record<StreamFilter, string> = {
  all: "All streams",
  in_store: "In-store and delivery",
  delivery: "Delivery",
  catering: "Catering",
  concessions: "Concessions",
};

export type SalesTargetRow = {
  /** "YYYY-MM-01" */
  month: string;
  stream: Exclude<Stream, "delivery">;
  amount: number;
  basis: string;
  provisional?: boolean;
  /** The basis the stream's sales are measured on against this row (concessions: Aramark's net settlement or register gross). */
  measure?: "net" | "gross";
};

/** A month's target as the page uses it: one stream's row, or the sum of them all. */
export type MonthTarget = { month: string; amount: number; basis: string; provisional: boolean };

/**
 * The month's target for a stream, or for the whole business ('all': the sum
 * of the month's stream rows, provisional when any part is). Null when
 * nothing is set.
 */
export function targetFor(rows: SalesTargetRow[], month: string, stream: StreamFilter): MonthTarget | null {
  const parts = rows.filter((r) => r.month === month && (stream === "all" || r.stream === stream));
  if (parts.length === 0) return null;
  if (stream !== "all") return { month, amount: Number(parts[0].amount), basis: parts[0].basis, provisional: Boolean(parts[0].provisional) };
  return {
    month,
    amount: round2(parts.reduce((s, r) => s + Number(r.amount), 0)),
    basis: "Sum of the stream targets",
    provisional: parts.some((r) => r.provisional),
  };
}

export type MonthProgress = {
  /** Day of the month the actual runs through (the as-of day, included). */
  day: number;
  days: number;
  target: number | null;
  actual: number;
  /** target x day / days: where a straight line to the target would be. */
  paceToDate: number | null;
  /** actual - paceToDate: positive is ahead. */
  vsPace: number | null;
  pctOfPace: number | null;
  pctOfTarget: number | null;
};

/** Month-to-date against the month's target, with linear pace (WEEKLY-02: pace = target x day/days). */
export function monthProgress({ target, actual, asOf }: { target: number | null; actual: number; asOf: string }): MonthProgress {
  const day = Number(asOf.slice(8, 10));
  const days = daysInMonth(asOf);
  if (target == null || target <= 0) {
    return { day, days, target: target ?? null, actual: round2(actual), paceToDate: null, vsPace: null, pctOfPace: null, pctOfTarget: null };
  }
  const paceToDate = round2((target * day) / days);
  return {
    day,
    days,
    target,
    actual: round2(actual),
    paceToDate,
    vsPace: round2(actual - paceToDate),
    pctOfPace: paceToDate > 0 ? round3(actual / paceToDate) : null,
    pctOfTarget: round3(actual / target),
  };
}
