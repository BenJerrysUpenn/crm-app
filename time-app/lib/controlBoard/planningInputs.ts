// The Labor Hours Planning inputs an owner keeps on the Targets tab
// (bj-finance #742, owner rulings 2026-10-19): store-hours seasons and
// concession events, beside the control board's settings.
// Closed days are store_hours_exceptions, which managers set; the three
// holidays the store closes for have quick-add buttons, their dates worked
// out from the calendar here.
//
// Storage is migration 47. A season is seven store_hours_seasons rows, one
// per weekday, keyed on its first day: saving a season again replaces its
// rows. An event is dated revisions, like a board setting: a change adds a
// revision under the same event_key, and the revision in force on a day is
// the latest on or before it (inForce in settings.ts). A revision with
// cancelled = true takes the event off.
//
// Nothing here holds a business figure: crm-app is public, and the owners
// enter every value. Pure, so `node --test` runs it and the routes, the page
// and the local preview validate identically.

import { holidaysForYear } from "../holidays.ts";
import { fmtStoreTime, parseSpan, WEEKDAY_NAMES } from "../storeHours.ts";
import type { StoreHoursException } from "../types.ts";
import type { ConcessionEvent, EventRevision } from "../metrics/laborPlanning.ts";
import { addMonthsTo, groupBy, historyOf, inForce, isDay, parseField, parseNote, type Parsed } from "./settings.ts";

/**
 * One change the editor sends: to its route on the Targets tab, or, on the
 * local preview, to the preview's inputs file (lib/metrics/laborPlanningSeed.ts).
 */
export type InputAction =
  | { kind: "season"; body: object }
  | { kind: "season_remove"; from: string }
  | { kind: "concession"; body: object }
  /** A closed day; with opens and closes ("HH:MM"), short hours instead. */
  | { kind: "closed_day"; body: { date: string; label: string; opens?: string; closes?: string } }
  | { kind: "closed_day_remove"; date: string };

/** The notes every dated input carries, as the board's settings do. */
export type InputNotes = { review_by: string; source: string; method: string | null };

// ---------------------------------------------------------------------------
// Closed days: the holidays with a quick-add button
// ---------------------------------------------------------------------------

/** The public holidays the store closes for, by their names in lib/holidays.ts. */
export const QUICK_HOLIDAYS = ["Thanksgiving", "Christmas Day", "New Year's Day"] as const;
export type QuickHoliday = (typeof QUICK_HOLIDAYS)[number];

/** The holiday's next date on or after `day`, from its calendar rule. */
export function nextHoliday(name: QuickHoliday, day: string): string {
  const year = Number(day.slice(0, 4));
  for (const y of [year, year + 1]) {
    const h = holidaysForYear(y).find((x) => x.name === name);
    if (h && h.date >= day) return h.date;
  }
  throw new Error(`no ${name} after ${day}`);
}

/** Each quick-add holiday's next date, and whether that date is already marked closed. */
export function quickHolidays(today: string, exceptions: StoreHoursException[]): { name: QuickHoliday; date: string; added: boolean }[] {
  return QUICK_HOLIDAYS.map((name) => {
    const date = nextHoliday(name, today);
    return { name, date, added: exceptions.some((e) => e.date === date && e.is_closed) };
  });
}

// ---------------------------------------------------------------------------
// Store-hours seasons
// ---------------------------------------------------------------------------

/** A row of public.store_hours_seasons as the Targets tab reads it. */
export type SeasonRow = {
  effective_from: string;
  weekday: number;
  name: string;
  is_closed: boolean;
  opens: string | null;
  closes: string | null;
  review_by: string | null;
  source: string | null;
  method: string | null;
};

/** A season: its seven weekday rows read as one. */
export type Season = {
  effective_from: string;
  name: string;
  /** The open days' hours ("HH:MM:SS"); the first open day's when they differ. */
  opens: string | null;
  closes: string | null;
  closedWeekdays: number[];
  /** True when the open days do not all keep the same hours (set outside this editor). */
  mixed: boolean;
  rows: SeasonRow[];
  review_by: string | null;
  source: string | null;
  method: string | null;
};

/** Season rows grouped by first day, oldest first. */
export function seasonsFrom(rows: SeasonRow[]): Season[] {
  const out: Season[] = [];
  for (const [from, list] of groupBy(rows, "effective_from")) {
    const days = [...list].sort((a, b) => a.weekday - b.weekday);
    const open = days.filter((r) => !r.is_closed);
    const first = open[0];
    out.push({
      effective_from: from,
      name: days[0].name,
      opens: first?.opens ?? null,
      closes: first?.closes ?? null,
      closedWeekdays: days.filter((r) => r.is_closed).map((r) => r.weekday),
      mixed: open.some((r) => r.opens !== first.opens || r.closes !== first.closes),
      rows: days,
      review_by: days[0].review_by,
      source: days[0].source,
      method: days[0].method,
    });
  }
  return out.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
}

/** The season in force on `day`: the latest started on or before it. None before the first. */
export function seasonInForce(seasons: Season[], day: string): Season | null {
  return [...seasons].reverse().find((s) => s.effective_from <= day) ?? null;
}

const hoursWords = (opens: string | null, closes: string | null) => `${fmtStoreTime(opens)} to ${fmtStoreTime(closes)}`;

function andList(words: string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** A season's hours in words: "1:00 PM to 9:00 PM, closed Monday". */
export function seasonWords(s: Season): string {
  if (s.closedWeekdays.length === 7) return "closed every day";
  if (s.mixed) {
    return s.rows.map((r) => `${WEEKDAY_NAMES[r.weekday].slice(0, 3)} ${r.is_closed ? "closed" : hoursWords(r.opens, r.closes)}`).join(", ");
  }
  const hours = hoursWords(s.opens, s.closes);
  if (s.closedWeekdays.length === 0) return `${hours} every day`;
  return `${hours}, closed ${andList(s.closedWeekdays.map((d) => WEEKDAY_NAMES[d]))}`;
}

/** A season's seven rows again, as a save writes them. */
export function seasonRowsFrom(s: Season): SeasonRow[] {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    const closed = s.closedWeekdays.includes(weekday);
    return {
      effective_from: s.effective_from, weekday, name: s.name, is_closed: closed,
      opens: closed ? null : s.opens, closes: closed ? null : s.closes,
      review_by: s.review_by, source: s.source, method: s.method,
    };
  });
}

/**
 * "Repeat next year": the season again from the same date a year on, as the
 * season form saves it, its review-by a year on too (a year after the new
 * first day when it had none).
 */
export function repeatNextYear(s: Season) {
  const from = addMonthsTo(s.effective_from, 12);
  return {
    name: s.name,
    effective_from: from,
    opens: (s.opens ?? "").slice(0, 5),
    closes: (s.closes ?? "").slice(0, 5),
    closed_weekdays: s.closedWeekdays,
    review_by: s.review_by ? addMonthsTo(s.review_by, 12) : addMonthsTo(from, 12),
    source: s.source || `Repeated from the ${s.name} season of ${s.effective_from}.`,
    method: s.method,
  };
}

/** A season as POST /api/payroll/targets/seasons receives it: its seven rows to write. */
export function parseSeasonInput(body: unknown): Parsed<SeasonRow[]> {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a JSON body." };
  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return { ok: false, error: "Give the season a name, like Winter." };
  if (name.length > 80) return { ok: false, error: "The season's name is at most 80 characters." };
  if (!isDay(b.effective_from)) return { ok: false, error: "The start date must be a date (YYYY-MM-DD)." };

  const closedRaw = b.closed_weekdays ?? [];
  if (!Array.isArray(closedRaw) || closedRaw.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    return { ok: false, error: "Closed weekdays must be weekdays from 0 (Sunday) to 6 (Saturday)." };
  const closed = new Set(closedRaw as number[]);

  let opens: string | null = null;
  let closes: string | null = null;
  if (closed.size < 7) {
    const span = parseSpan({ is_closed: false, opens: b.opens, closes: b.closes }, "The season");
    if (!span.ok) return span;
    ({ opens, closes } = span.value);
  }
  const note = parseNote(b);
  if (!note.ok) return note;
  const { review_by, source, method } = note.value;
  return {
    ok: true,
    value: seasonRowsFrom({
      effective_from: b.effective_from, name, opens, closes, closedWeekdays: [...closed].sort(), mixed: false, rows: [],
      review_by, source, method,
    }),
  };
}

// ---------------------------------------------------------------------------
// Concession events: dated revisions
// ---------------------------------------------------------------------------

export type ConcessionEventRow = ConcessionEvent & EventRevision & InputNotes & { provisional: boolean };

export type EventEntry<T> = {
  key: string;
  /** The revision in force today, or, before any is, the first that will be. */
  current: T;
  inForce: boolean;
  /** Every revision, newest first. */
  history: T[];
};

const firstDay = (r: object) => ("start_date" in r ? String(r.start_date) : "");

/** Each event as it stands today, with its history, by its first day. Cancelled events are kept: they show as taken off. */
export function eventList<T extends EventRevision>(rows: T[], today: string): EventEntry<T>[] {
  const out: EventEntry<T>[] = [];
  for (const [key, list] of groupBy(rows, "event_key")) {
    const history = historyOf(list);
    const now = inForce(list, today);
    out.push({ key, current: now ?? history[history.length - 1], inForce: now != null, history });
  }
  return out.sort((a, b) => firstDay(a.current).localeCompare(firstDay(b.current)) || a.key.localeCompare(b.key));
}

const KEY_MAX = 80;

/** A new event's key: its name in lower-case words, with the year of its first day, never one already taken. */
export function eventKeyFor(name: string, firstDayOfEvent: string, taken: Set<string>): string {
  const year = firstDayOfEvent.slice(0, 4);
  let base = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "event";
  if (!new RegExp(`(^|-)${year}(-|$)`).test(base)) base = `${base}-${year}`;
  base = base.slice(0, KEY_MAX - 4).replace(/-+$/, "");
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A positive amount with cents, below `max`. */
function amount(raw: unknown, label: string, max: number): Parsed<number> {
  const p = parseField({ name: "value", kind: "money", digits: 2, label }, raw);
  if (!p.ok) return p;
  const n = p.value as number;
  if (n >= max) return { ok: false, error: `${label} is too large.` };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

type Common = { event_key: string; name: string; cancelled: boolean; effective_from: string } & InputNotes;

/** What every event revision has: its key (new or existing), its name, and the board's notes. */
function parseCommon(b: Record<string, unknown>, first: string, taken: Set<string>): Parsed<Common> {
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return { ok: false, error: "Give the event a name." };
  if (name.length > 120) return { ok: false, error: "The event's name is at most 120 characters." };
  let key: string;
  if (b.event_key == null || b.event_key === "") key = eventKeyFor(name, first, taken);
  else if (typeof b.event_key === "string" && taken.has(b.event_key)) key = b.event_key;
  else return { ok: false, error: "No such event." };
  const note = parseNote(b);
  if (!note.ok) return note;
  return { ok: true, value: { event_key: key, name, cancelled: b.cancelled === true, ...note.value } };
}

export type ConcessionInsert = Common & ConcessionEvent & { provisional: boolean };

/**
 * A concession event revision, as POST /api/payroll/targets/concession-events
 * receives it. No event_key is a new event; `taken` is every key on file.
 */
export function parseConcessionInput(body: unknown, taken: Set<string>): Parsed<ConcessionInsert> {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a JSON body." };
  const b = body as Record<string, unknown>;
  if (!isDay(b.start_date)) return { ok: false, error: "The first day must be a date (YYYY-MM-DD)." };
  if (!isDay(b.end_date)) return { ok: false, error: "The last day must be a date (YYYY-MM-DD)." };
  if (b.end_date < b.start_date) return { ok: false, error: "The event cannot end before it starts." };
  const sales = amount(b.expected_net_sales, "Expected net sales", 1e9);
  if (!sales.ok) return sales;
  const common = parseCommon(b, b.start_date, taken);
  if (!common.ok) return common;
  return {
    ok: true,
    value: { ...common.value, start_date: b.start_date, end_date: b.end_date, expected_net_sales: sales.value, provisional: b.provisional === true },
  };
}
