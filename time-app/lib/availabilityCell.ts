// What a person/day cell on the manager's schedule grid says about
// availability. Modelled on When I Work: a day they can't work is shaded and
// labelled; a day with hours shows them in one or two short lines; a day with
// nothing on file gets a faint marker that must not read as "unavailable".
//
// This only turns a ResolvedDay into words. What the person said about the day
// is decided by resolveDay in lib/availabilityCheck.ts, the same resolver the
// save check uses, so the grid can never disagree with them.
//
// Pure, so `node --test` runs it.

import { summariseDay, type Kind, type ResolvedDay } from "./availabilityCheck.ts";
import { mergeIntervals } from "./coverage.ts";

/** One short line for a day with hours, e.g. "Can't 6–8p". */
export type CellLine = { kind: Kind; text: string };

export type CellAvailability =
  /** Approved time off: the whole cell is shaded. */
  | { state: "time_off"; label: string; title: string }
  /** Time off asked for and not yet decided: amber, not shaded grey. */
  | { state: "time_off_pending"; label: string; title: string }
  /** "Can't work" covering the whole day: the whole cell is shaded. */
  | { state: "unavailable"; label: string; title: string }
  /** Some hours on file: one line per kind, can't-work first. */
  | { state: "hours"; lines: CellLine[]; title: string }
  /** Nothing on file for the day: a faint marker, not a warning. */
  | { state: "none"; label: string; title: string };

const LINE_WORD: Record<Kind, string> = {
  unavailable: "Can't",
  preferred: "Prefers",
  available: "Avail",
};

// Can't-work first: it is the one a manager must not miss.
const LINE_ORDER: Kind[] = ["unavailable", "preferred", "available"];

/** Minutes since midnight as a short clock: 360 → "6a", 1110 → "6:30p", 1440 → "12a". */
export function shortClock(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const hour24 = Math.floor(m / 60) % 24;
  const mins = m % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}${mins ? `:${String(mins).padStart(2, "0")}` : ""}${hour24 >= 12 ? "p" : "a"}`;
}

/**
 * A stretch of the day, short: "6–8p", "9a–5p", "11:30a–2p", "all day".
 * The first time drops its a/p when both ends share it.
 */
export function shortSpan(from: number, to: number): string {
  if (from <= 0 && to >= 1440) return "all day";
  const a = shortClock(from);
  const b = shortClock(to);
  const sameHalf = a.slice(-1) === b.slice(-1);
  return `${sameHalf ? a.slice(0, -1) : a}–${b}`;
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** What a schedule-grid cell shows for one person on one date. */
export function availabilityCell(day: ResolvedDay): CellAvailability {
  // The full sentence, for the cell's hover title.
  const title = capitalise(summariseDay(day));

  if (day.timeOff === "approved") return { state: "time_off", label: "Time off", title };
  if (day.timeOff === "pending") return { state: "time_off_pending", label: "Time off pending", title };
  if (day.blocks.length === 0) return { state: "none", label: "no avail.", title: "No availability on file" };

  const byKind = (kind: Kind) => mergeIntervals(day.blocks.filter((b) => b.kind === kind));
  const cantWork = byKind("unavailable");
  if (cantWork.length === 1 && cantWork[0].from <= 0 && cantWork[0].to >= 1440) {
    return { state: "unavailable", label: "Unavailable", title };
  }

  const lines: CellLine[] = [];
  for (const kind of LINE_ORDER) {
    const spans = byKind(kind);
    if (spans.length) lines.push({ kind, text: `${LINE_WORD[kind]} ${spans.map((s) => shortSpan(s.from, s.to)).join(", ")}` });
  }
  return { state: "hours", lines, title };
}
