// The Team view on the Availability page: one row per person on the roster,
// one cell per day of the week, each cell saying what that person has put down
// for that day.
//
// The day itself is resolved by lib/availabilityCheck.ts (resolveDay), the same
// definition the schedule checks use, so this grid and the mismatch warnings
// never disagree. This module only turns a resolved day into what a cell shows.
//
// Pure and dependency-free, so `node --test` runs it.

import { resolveDay, type AvailabilityRow, type Kind, type ResolvedDay } from "./availabilityCheck.ts";
import { mergeIntervals, weekDates } from "./coverage.ts";

/** One person on the roster, in the order the Schedule page lists them. */
export type RosterPerson = { id: string; full_name: string | null };

/** One short line in a cell: "Can't 6–8p". `weekly` when it all comes from the repeating pattern. */
export type CellLine = { kind: Kind; text: string; weekly: boolean };

export type Cell =
  | { date: string; state: "time_off"; status: "approved" | "pending" }
  /** "Can't work" for the whole day. */
  | { date: string; state: "unavailable"; weekly: boolean }
  | { date: string; state: "blocks"; lines: CellLine[] }
  /** Nothing on file for this day. */
  | { date: string; state: "none" };

export type TeamRow = {
  id: string;
  name: string;
  cells: Cell[];
  /** False when every day of the week is "none". */
  submitted: boolean;
};

export type TeamGrid = {
  dates: string[];
  rows: TeamRow[];
  submittedCount: number;
  /** People with at least one day of pending time off this week. */
  pendingTimeOffCount: number;
};

const LABEL: Record<Kind, string> = { unavailable: "Can't", available: "Avail", preferred: "Prefers" };
// Order the lines read in a cell, top to bottom, when they start together.
const KIND_ORDER: Kind[] = ["preferred", "available", "unavailable"];

/**
 * Minutes past midnight to a short clock: 0 → "12a", 750 → "12:30p", 1440 → "12a".
 * `withSuffix` false drops the "a"/"p".
 */
function shortClock(minutes: number, withSuffix = true): string {
  const hour24 = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const suffix = withSuffix ? (hour24 >= 12 ? "p" : "a") : "";
  return `${hour12}${mins ? ":" + String(mins).padStart(2, "0") : ""}${suffix}`;
}

/** "6–8p", "9a–5p", "12–2a", or "all day". Drops the first suffix when both ends share it. */
export function shortSpan(from: number, to: number): string {
  if (from === 0 && to === 1440) return "all day";
  const sameHalf = (Math.floor(from / 60) % 24 >= 12) === (Math.floor(to / 60) % 24 >= 12) && to - from < 720;
  return `${shortClock(from, !sameHalf)}–${shortClock(to)}`;
}

/** What one resolved day shows in its cell. */
export function cellFor(day: ResolvedDay): Cell {
  const date = day.date;
  if (day.timeOff) return { date, state: "time_off", status: day.timeOff };
  if (day.blocks.length === 0) return { date, state: "none" };

  const cant = mergeIntervals(day.blocks.filter((b) => b.kind === "unavailable"));
  if (cant.length === 1 && cant[0].from === 0 && cant[0].to === 1440) {
    return { date, state: "unavailable", weekly: day.blocks.every((b) => b.source === "weekly") };
  }

  // One line per stretch of each kind. Touching blocks of the same kind from
  // different sources (weekly 12–5, dated 5–8) read as one stretch, 12–8.
  const lines: (CellLine & { from: number })[] = [];
  for (const kind of KIND_ORDER) {
    const mine = day.blocks.filter((b) => b.kind === kind);
    for (const span of mergeIntervals(mine)) {
      const inside = mine.filter((b) => b.from < span.to && b.to > span.from);
      lines.push({
        kind,
        from: span.from,
        text: `${LABEL[kind]} ${shortSpan(span.from, span.to)}`,
        weekly: inside.every((b) => b.source === "weekly"),
      });
    }
  }
  lines.sort((a, b) => a.from - b.from || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return { date, state: "blocks", lines: lines.map(({ kind, text, weekly }) => ({ kind, text, weekly })) };
}

/**
 * The grid for the week beginning `weekStart` (a Sunday). Every roster person
 * gets a row, in roster order, whether or not they have entered anything.
 * `rows` may hold anyone's availability rows; people not on the roster are left
 * out. Pass dated rows from the day before `weekStart` so an overnight block
 * from that Saturday reaches Sunday.
 */
export function buildTeamGrid(roster: RosterPerson[], weekStart: string, rows: AvailabilityRow[]): TeamGrid {
  const dates = weekDates(weekStart);
  const byPerson = new Map<string, AvailabilityRow[]>();
  for (const r of rows) {
    const arr = byPerson.get(r.employee_id) ?? [];
    arr.push(r);
    byPerson.set(r.employee_id, arr);
  }

  let submittedCount = 0;
  let pendingTimeOffCount = 0;
  const out: TeamRow[] = roster.map((p) => {
    const mine = byPerson.get(p.id) ?? [];
    const cells = dates.map((d) => cellFor(resolveDay(p.id, d, mine)));
    const submitted = cells.some((c) => c.state !== "none");
    if (submitted) submittedCount++;
    if (cells.some((c) => c.state === "time_off" && c.status === "pending")) pendingTimeOffCount++;
    return { id: p.id, name: p.full_name?.trim() || p.id, cells, submitted };
  });

  return { dates, rows: out, submittedCount, pendingTimeOffCount };
}

/** "6 of 10 submitted availability this week · 2 time-off pending". */
export function summaryLine(grid: TeamGrid): string {
  const parts = [`${grid.submittedCount} of ${grid.rows.length} submitted availability this week`];
  if (grid.pendingTimeOffCount > 0) parts.push(`${grid.pendingTimeOffCount} time-off pending`);
  return parts.join(" · ");
}

/** The words for a cell, for its tooltip and screen readers. */
export function cellTitle(cell: Cell): string {
  switch (cell.state) {
    case "time_off":
      return cell.status === "approved" ? "Time off (approved)" : "Time off requested, not yet decided";
    case "unavailable":
      return cell.weekly ? "Can't work all day (every week)" : "Can't work all day";
    case "none":
      return "No availability on file";
    case "blocks":
      return cell.lines.map((l) => `${l.text}${l.weekly ? " (every week)" : ""}`).join("; ");
  }
}
