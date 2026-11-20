// LOCAL PREVIEW ONLY (bj-finance #742): the planning inputs file the local
// preview reads in place of migration 47's tables, and how the editor's
// changes are written to it (app/api/dev/labor-planning-inputs). Its shape is
// what bj-finance's `modules.labor_planning inputs` loader reads (seasons as
// groups of weekdays, events as revisions), so the file stays loadable as it
// stands. `closed_days` is the preview's own: the loader ignores it, and the
// preview counts those days closed (or on short hours) instead of writing
// store_hours_exceptions. Keys the editor does not know (`_about`, the
// loader's `marketing_days`) are kept as they are.
//
// Every change is checked by the same rules as the routes
// (lib/controlBoard/planningInputs.ts). Pure, so `node --test` runs it.

import {
  parseConcessionInput,
  parseSeasonInput,
  type InputAction,
  type SeasonRow,
} from "../controlBoard/planningInputs.ts";
import { isDay, type Parsed } from "../controlBoard/settings.ts";
import { parseSpan } from "../storeHours.ts";
import type { StoreHoursException } from "../types.ts";

/** A season group: one set of hours (or closed) on some weekdays (every day when none are listed). */
export type SeedSeason = {
  name: string;
  effective_from: string;
  opens?: string;
  closes?: string;
  is_closed?: boolean;
  weekdays?: number[];
  review_by?: string | null;
  source?: string | null;
  method?: string | null;
};

type SeedRevision = { event_key: string; effective_from: string; cancelled?: boolean; recorded_at?: string };

export type Seed = {
  seasons?: SeedSeason[];
  concession_events?: (SeedRevision & Record<string, unknown>)[];
  /** A closed day, or short hours when it has opens and closes. */
  closed_days?: { date: string; label: string | null; opens?: string; closes?: string }[];
  [other: string]: unknown;
};

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];
const hhmm = (t: string | null) => (t ?? "").slice(0, 5);

/** Season groups as store_hours_seasons rows, seven per season. */
export function seedSeasonRows(seed: Seed): SeasonRow[] {
  return (seed.seasons ?? []).flatMap((s) =>
    (s.weekdays ?? ALL_WEEK).map((weekday) => ({
      effective_from: s.effective_from,
      weekday,
      name: s.name,
      is_closed: !!s.is_closed,
      opens: s.is_closed ? null : `${s.opens}:00`,
      closes: s.is_closed ? null : `${s.closes}:00`,
      review_by: s.review_by ?? null,
      source: s.source ?? null,
      method: s.method ?? null,
    })),
  );
}

/**
 * Revisions as the tables would hold them: an id in file order, so of two
 * recorded at the same moment the later in the file wins, and a recorded
 * time (a hand-written revision has none: its as-of date stands in).
 */
export function seedRevisions<T extends SeedRevision>(rows: T[] | undefined): (T & { id: number; recorded_at: string; cancelled: boolean })[] {
  return (rows ?? []).map((r, i) => ({ ...r, id: i + 1, recorded_at: r.recorded_at ?? `${r.effective_from}T00:00:00Z`, cancelled: !!r.cancelled }));
}

/** The file's closed days (and short hours) as store-hours exceptions. */
export function seedClosedDays(seed: Seed): StoreHoursException[] {
  return (seed.closed_days ?? []).map((d) => {
    const short = !!(d.opens && d.closes);
    return { date: d.date, label: d.label, is_closed: !short, opens: short ? `${d.opens}:00` : null, closes: short ? `${d.closes}:00` : null, created_at: null };
  });
}

/** A season's seven rows as the loader's groups: the open weekdays, then the closed ones. */
function seasonGroups(rows: SeasonRow[]): SeedSeason[] {
  const [first] = rows;
  const notes: Pick<SeedSeason, "review_by" | "source" | "method"> = { review_by: first.review_by, source: first.source, method: first.method };
  const open = rows.filter((r) => !r.is_closed);
  const closed = rows.filter((r) => r.is_closed);
  const groups: SeedSeason[] = [];
  if (open.length) {
    groups.push({
      name: first.name, effective_from: first.effective_from, opens: hhmm(open[0].opens), closes: hhmm(open[0].closes),
      ...(open.length < 7 ? { weekdays: open.map((r) => r.weekday) } : {}), ...notes,
    });
  }
  if (closed.length) groups.push({ name: first.name, effective_from: first.effective_from, is_closed: true, weekdays: closed.map((r) => r.weekday), ...notes });
  return groups;
}

const keysOf = (rows: Record<string, unknown>[] | undefined) => new Set((rows ?? []).map((r) => String(r.event_key)));

/** The file with one change made, or why the change was refused. `now` is when it was recorded. */
export function applySeedAction(seed: Seed, a: InputAction, now: string): Parsed<Seed> {
  switch (a?.kind) {
    case "season": {
      const p = parseSeasonInput(a.body);
      if (!p.ok) return p;
      const from = p.value[0].effective_from;
      const seasons = [...(seed.seasons ?? []).filter((s) => s.effective_from !== from), ...seasonGroups(p.value)];
      return { ok: true, value: { ...seed, seasons: seasons.sort((x, y) => x.effective_from.localeCompare(y.effective_from)) } };
    }
    case "season_remove":
      if (!isDay(a.from)) return { ok: false, error: "Which season? Give its start date (YYYY-MM-DD)." };
      return { ok: true, value: { ...seed, seasons: (seed.seasons ?? []).filter((s) => s.effective_from !== a.from) } };
    case "concession": {
      const p = parseConcessionInput(a.body, keysOf(seed.concession_events));
      if (!p.ok) return p;
      return { ok: true, value: { ...seed, concession_events: [...(seed.concession_events ?? []), { ...p.value, recorded_at: now }] } };
    }
    case "closed_day": {
      const { date } = a.body ?? {};
      if (!isDay(date)) return { ok: false, error: "Pick a real date, like 2026-11-26." };
      const label = typeof a.body.label === "string" ? a.body.label.trim() : "";
      if (label.length > 120) return { ok: false, error: "Label is too long (120 characters max)." };
      const short = !!(a.body.opens || a.body.closes);
      const span = parseSpan({ is_closed: !short, opens: a.body.opens, closes: a.body.closes }, date);
      if (!span.ok) return span;
      const hours = short ? { opens: hhmm(span.value.opens), closes: hhmm(span.value.closes) } : {};
      const days = [...(seed.closed_days ?? []).filter((d) => d.date !== date), { date, label: label || null, ...hours }];
      return { ok: true, value: { ...seed, closed_days: days.sort((x, y) => x.date.localeCompare(y.date)) } };
    }
    case "closed_day_remove":
      if (!isDay(a.date)) return { ok: false, error: "Pick a real date, like 2026-11-26." };
      return { ok: true, value: { ...seed, closed_days: (seed.closed_days ?? []).filter((d) => d.date !== a.date) } };
    default:
      return { ok: false, error: "Unknown change." };
  }
}
