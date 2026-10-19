// The week range the Labor vs target card covers (bj-finance #696; Alina,
// 2026-10-18: "rather than just a month picker can we have a week range
// picker?"). A range is a first and a last Sunday-to-Saturday week, each
// named by its Sunday, chosen from the first week the business ran under
// Withers to the week holding today.
//
// A widget's settings keep the range as `from` and `to` (both Sundays,
// "YYYY-MM-DD"). Unset, the card shows the last DEFAULT_WEEKS weeks ending
// with the most recent week that is over, and moves on with the calendar. A
// view saved while the card had a month picker keeps that month: its
// `month` is read as that month's weeks (each week that starts in it).
//
// Month shortcuts (Alina, 2026-10-18: "with options for highlighting
// particular months") set the range to one month's weeks by the same rule.
//
// Pure: no React, no Supabase. The saved views, the page loader and the card
// all use it.

import { addDays, monthEnd, monthLabel, shortDay } from "./dates.ts";

/** The first week on offer: the first Sunday-to-Saturday week under Withers. */
export const FIRST_LABOR_WEEK = "2026-05-03";

/** How many weeks the card shows until a range is chosen. */
export const DEFAULT_WEEKS = 8;

export type WeekRange = { from: string; to: string };

function dayOfWeek(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday
}

/** A real calendar day, "YYYY-MM-DD", that is a Sunday. */
export function isSunday(x: unknown): x is string {
  if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const d = new Date(`${x}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === x && d.getUTCDay() === 0;
}

/** The Sunday of the Sunday-to-Saturday week holding `day`. */
export function sundayOf(day: string): string {
  return addDays(day, -dayOfWeek(day));
}

/** The Sundays of `month` ("YYYY-MM"): each starts one of its weeks. */
export function monthWeeks(month: string): string[] {
  const first = `${month}-01`;
  const out: string[] = [];
  for (let d = addDays(first, (7 - dayOfWeek(first)) % 7); d <= monthEnd(first); d = addDays(d, 7)) out.push(d);
  return out;
}

/** The weeks on offer on `today`, oldest first: FIRST_LABOR_WEEK to the week holding today. */
export function laborWeekStarts(today: string): string[] {
  const last = sundayOf(today);
  const out: string[] = [];
  for (let d = FIRST_LABOR_WEEK; d <= last; d = addDays(d, 7)) out.push(d);
  return out.length ? out : [FIRST_LABOR_WEEK];
}

/** The range a card shows until one is chosen: the last DEFAULT_WEEKS weeks ending with the most recent week that is over. */
export function defaultLaborRange(today: string): WeekRange {
  const lastOver = addDays(sundayOf(today), -7);
  const to = lastOver < FIRST_LABOR_WEEK ? FIRST_LABOR_WEEK : lastOver;
  const from = addDays(to, -7 * (DEFAULT_WEEKS - 1));
  return { from: from < FIRST_LABOR_WEEK ? FIRST_LABOR_WEEK : from, to };
}

/**
 * A widget's saved range, as cleanSettings keeps it: `from` and `to` when
 * both are Sundays in order; else an old saved `month` ("YYYY-MM") as that
 * month's weeks; else nothing (the default range).
 */
export function savedRange(from: unknown, to: unknown, month: unknown): WeekRange | null {
  if (isSunday(from) && isSunday(to) && from <= to) return { from, to };
  if (typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    const weeks = monthWeeks(month);
    return { from: weeks[0], to: weeks[weeks.length - 1] };
  }
  return null;
}

/** The weeks a card can show (each named by its Sunday, oldest first) and the range it shows until one is chosen. */
export type WeeksOnOffer = { weeks: { start: string }[]; defaultRange: WeekRange };

/**
 * The range a card shows: the saved one cut to the weeks on offer, or the
 * offer's default range when none is saved or none of it is on offer.
 */
export function shownRange(saved: Partial<WeekRange> | undefined, offer: WeeksOnOffer): WeekRange {
  const { weeks, defaultRange: fallback } = offer;
  const range = savedRange(saved?.from, saved?.to, undefined);
  if (!range || !weeks.length) return fallback;
  const first = weeks[0].start;
  const last = weeks[weeks.length - 1].start;
  const from = range.from < first ? first : range.from;
  const to = range.to > last ? last : range.to;
  return from <= to ? { from, to } : fallback;
}

/**
 * What the picker saves when one end changes: the other end moves with it
 * when they would cross, and a range equal to the default is saved as unset,
 * so the card keeps moving on with the calendar.
 */
export function pickRange(current: WeekRange, end: "from" | "to", week: string, fallback: WeekRange): Partial<WeekRange> {
  const next = end === "from" ? { from: week, to: week > current.to ? week : current.to } : { from: week < current.from ? week : current.from, to: week };
  return next.from === fallback.from && next.to === fallback.to ? { from: undefined, to: undefined } : next;
}

/** A week's name in the picker: its Sunday, "May 3", with the year when the weeks on offer span more than one. */
export function weekOptionLabel(sunday: string, starts: string[]): string {
  const years = starts.length > 0 && starts[0].slice(0, 4) !== starts[starts.length - 1].slice(0, 4);
  return years ? `${shortDay(sunday)}, ${sunday.slice(0, 4)}` : shortDay(sunday);
}

/** "Aug 23 to Oct 11", or "Aug 23" for a single week. */
export function rangeLabel(r: WeekRange): string {
  return r.from === r.to ? shortDay(r.from) : `${shortDay(r.from)} to ${shortDay(r.to)}`;
}

export type MonthShortcut = {
  /** "YYYY-MM" */
  month: string;
  /** "May", or "May 2026" once the months on offer span two years. */
  label: string;
  /** "May 2026" */
  name: string;
  /** The month's weeks: each week whose Sunday falls in it. */
  range: WeekRange;
};

/** A shortcut for each month holding a week on offer, oldest first. */
export function monthShortcuts(offer: WeeksOnOffer): MonthShortcut[] {
  const months = [...new Set(offer.weeks.map((w) => w.start.slice(0, 7)))];
  const years = months.length > 0 && months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
  return months.map((month) => {
    const weeks = monthWeeks(month);
    const name = monthLabel(`${month}-01`);
    return { month, label: years ? name : name.slice(0, 3), name, range: { from: weeks[0], to: weeks[weeks.length - 1] } };
  });
}

/** The shortcut the range shown equals, if any: a month whose weeks, cut to those on offer, are exactly the range. */
export function activeShortcut(shown: WeekRange, shortcuts: MonthShortcut[], offer: WeeksOnOffer): string | null {
  const hit = shortcuts.find((m) => {
    const r = shownRange(m.range, offer);
    return r.from === shown.from && r.to === shown.to;
  });
  return hit?.month ?? null;
}

/** The month menu's "no single month" choice: the range is not one month's weeks. */
export const CUSTOM_RANGE = "custom";

export type MonthChoice = { value: string; label: string; range: WeekRange | null };

/**
 * The Labor vs target card's month menu: "Custom", then each month holding a
 * week on offer, oldest first, by its full name ("May 2026"). Choosing a month
 * sets the range to its weeks; "Custom" leaves the range as it is.
 */
export function monthChoices(offer: WeeksOnOffer): MonthChoice[] {
  return [
    { value: CUSTOM_RANGE, label: "Custom", range: null },
    ...monthShortcuts(offer).map((m) => ({ value: m.month, label: m.name, range: m.range })),
  ];
}

/** What the month menu shows for the range shown: its month while the range is one, else "Custom". */
export function monthChoiceFor(shown: WeekRange, offer: WeeksOnOffer): string {
  return activeShortcut(shown, monthShortcuts(offer), offer) ?? CUSTOM_RANGE;
}
