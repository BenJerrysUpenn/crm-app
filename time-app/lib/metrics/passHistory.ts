// The bookkeeping pass history (bj-finance #937, migration 56): one row per
// run of DAILY-02, DAILY-03 or WEEKLY-02, written by the pass itself (bj-finance
// modules/pass_history.py) at the end of its run. The
// Metrics page draws it as a card: dollars booked and bank lines left waiting
// for review, day by day, with every run behind "Show numbers".
//
// Pure: parsing the rows PostgREST returns and shaping the chart's days.

import { addDays } from "./dates.ts";

export type PassRun = {
  runDate: string;
  passCode: string;
  runLabel: string;
  attended: boolean;
  postedCount: number | null;
  postedDollars: number | null;
  queueBefore: number | null;
  queueAfter: number | null;
  cash: number | null;
  issuesFiled: number[];
  note: string;
  source: "pass" | "backfill";
};

export const PASS_RUN_COLUMNS =
  "run_date, pass_code, run_label, attended, posted_count, posted_dollars, queue_before, queue_after, cash, issues_filed, note, source";

/** The pass whose posting and review queue the chart draws. */
export const BOOKKEEPING_PASS = "DAILY-02";

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One row as read; null when it is not a pass run (a column renamed under the page). */
export function parsePassRun(r: Record<string, unknown>): PassRun | null {
  const runDate = typeof r.run_date === "string" ? r.run_date.slice(0, 10) : null;
  if (!runDate || !/^\d{4}-\d{2}-\d{2}$/.test(runDate)) return null;
  if (typeof r.pass_code !== "string" || typeof r.attended !== "boolean") return null;
  const issues = Array.isArray(r.issues_filed) ? r.issues_filed.map(num).filter((n): n is number => n != null) : [];
  return {
    runDate,
    passCode: r.pass_code,
    runLabel: typeof r.run_label === "string" ? r.run_label : "",
    attended: r.attended,
    postedCount: num(r.posted_count),
    postedDollars: num(r.posted_dollars),
    queueBefore: num(r.queue_before),
    queueAfter: num(r.queue_after),
    cash: num(r.cash),
    issuesFiled: issues,
    note: typeof r.note === "string" ? r.note : "",
    source: r.source === "backfill" ? "backfill" : "pass",
  };
}

/** Oldest first; on one day, by pass, the day's plain run before a named sitting. */
export function sortRuns(runs: PassRun[]): PassRun[] {
  return [...runs].sort(
    (a, b) =>
      (a.runDate < b.runDate ? -1 : a.runDate > b.runDate ? 1 : 0) ||
      a.passCode.localeCompare(b.passCode) ||
      a.runLabel.localeCompare(b.runLabel),
  );
}

export type PassDay = {
  day: string;
  /** Dollars the bookkeeping pass booked that day, every sitting added; null when no run that day says. */
  booked: number | null;
  /** Bank lines left waiting for review after the day's last sitting; null when it did not say. */
  waiting: number | null;
};

/**
 * The bookkeeping pass's days in the last `days` days through `today` (the
 * same period as runsInPeriod), one per day it ran: a day it did not run is
 * left out, never drawn as nothing booked.
 */
export function passDays(runs: PassRun[], today: string, days: number): PassDay[] {
  const from = addDays(today, -days);
  const byDay = new Map<string, PassRun[]>();
  for (const r of sortRuns(runs)) {
    if (r.passCode !== BOOKKEEPING_PASS || r.runDate < from || r.runDate > today) continue;
    byDay.set(r.runDate, [...(byDay.get(r.runDate) ?? []), r]);
  }
  return [...byDay.entries()].map(([day, rs]) => {
    const dollars = rs.map((r) => r.postedDollars).filter((v): v is number => v != null);
    const waiting = [...rs].reverse().find((r) => r.queueAfter != null)?.queueAfter ?? null;
    return { day, booked: dollars.length ? Math.round(dollars.reduce((s, v) => s + v, 0) * 100) / 100 : null, waiting };
  });
}

/** The runs a card covers: the last `days` days through `today`, every pass, newest first. */
export function runsInPeriod(runs: PassRun[], today: string, days: number): PassRun[] {
  const from = addDays(today, -days);
  return sortRuns(runs.filter((r) => r.runDate >= from && r.runDate <= today)).reverse();
}

/** "scheduled" or "with someone", plus the sitting's name when it has one. */
export function whoRan(r: PassRun): string {
  const who = r.attended ? "with someone" : "scheduled";
  return r.runLabel ? `${who}, ${r.runLabel}` : who;
}
