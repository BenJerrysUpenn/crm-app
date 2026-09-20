// Shared validation and shaping for store hours. Pure — no Supabase, no
// next/headers — so both the API routes and the Team page UI can import it.

import type { StoreHours, StoreHoursException } from "@/lib/types";

// Sunday-first, matching Date#getDay and the schedule board's week.
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// "Migration 24 has not been applied yet" arrives in two different dialects,
// and we have to recognise both.
//
//  * Postgres itself, when the statement reaches the database:
//      42P01 relation "public.store_hours" does not exist
//      42703 column "in_store" of relation "shift_types" does not exist
//  * PostgREST, which on hosted Supabase rejects the request before it ever
//    reaches Postgres because the object is absent from its schema cache:
//      PGRST205 Could not find the table 'public.store_hours' in the schema cache
//      PGRST204 Could not find the 'in_store' column of 'shift_types' in the schema cache
//      PGRST202 (same idea, for a function)
//
// Hosted Supabase is the deployment that matters, so the PGRST codes are the
// ones that actually fire in production. Matching only the Postgres codes made
// the Team page render the full editor before migration 24 and surface a raw
// schema-cache error on save.
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST202"]);
const MISSING_COLUMN_CODES = new Set(["42703", "PGRST204"]);

type MaybePgError = { code?: string; message?: string } | null | undefined;

// True when a query failed only because the table isn't there yet. Callers use
// this to degrade to an empty, clearly-labelled state instead of a 500.
export function isMissingTable(error: MaybePgError): boolean {
  if (!error) return false;
  const m = error.message ?? "";
  // An error about a COLUMN is never a missing table, and both dialects make
  // that easy to get wrong: Postgres says
  //   column "in_store" of relation "shift_types" does not exist
  // which contains "relation ... does not exist", and PostgREST's column error
  // says "in the schema cache" just like its table error. Rule this out first
  // or a missing column sends the manager off to run an applied migration.
  if (/\bcolumn\b/i.test(m)) return false;
  if (error.code && MISSING_TABLE_CODES.has(error.code)) return true;
  if (/relation\b.*\bdoes not exist/i.test(m)) return true;
  return /schema cache/i.test(m) && /\btable\b/i.test(m);
}

// True when a write failed only because shift_types.in_store isn't there yet,
// so the caller can retry without the column instead of failing the edit.
export function isMissingInStoreColumn(error: MaybePgError): boolean {
  if (!error) return false;
  const m = error.message ?? "";
  // A message that names some other column is not about in_store — retrying
  // without in_store would not help and would hide the real error.
  if (m && /\bcolumn\b/i.test(m) && !/in_store/i.test(m)) return false;
  if (error.code && MISSING_COLUMN_CODES.has(error.code)) return true;
  return /in_store/i.test(m) && (/does not exist/i.test(m) || /schema cache/i.test(m));
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// Accepts "HH:MM" (what <input type="time"> produces) or "HH:MM:SS" (what
// Postgres returns) and normalises to "HH:MM:SS". Empty/absent becomes null.
export function parseTime(value: unknown, field: string): Parsed<string | null> {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${field} must be a time like 11:00.` };
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return { ok: false, error: `${field} must be a time like 11:00.` };
  const [h, min, sec] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || min > 59 || sec > 59)
    return { ok: false, error: `${field} is not a real time of day.` };
  return { ok: true, value: `${m[1]}:${m[2]}:${m[3] ?? "00"}` };
}

// "HH:MM:SS" -> "HH:MM" for time inputs. Safe on null and on already-short
// values.
export function toTimeInput(value: string | null | undefined): string {
  return (value ?? "").slice(0, 5);
}

// "13:00:00" -> "1:00 PM". Used for reading back what is set.
export function fmtStoreTime(value: string | null | undefined): string {
  if (!value) return "—";
  const [h, m] = value.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return "—";
  const suffix = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

// One open/close pair, checked against the same rule the table's CHECK
// constraint enforces: closed, or a real range that ends after it starts.
export function parseSpan(
  raw: { is_closed?: unknown; opens?: unknown; closes?: unknown },
  label: string,
): Parsed<{ is_closed: boolean; opens: string | null; closes: string | null }> {
  const isClosed = raw.is_closed === true || raw.is_closed === "true";
  if (isClosed) return { ok: true, value: { is_closed: true, opens: null, closes: null } };

  const opens = parseTime(raw.opens, `${label} opening time`);
  if (!opens.ok) return opens;
  const closes = parseTime(raw.closes, `${label} closing time`);
  if (!closes.ok) return closes;
  if (!opens.value || !closes.value)
    return { ok: false, error: `${label} needs an opening and a closing time, or mark it closed.` };
  if (opens.value >= closes.value)
    return { ok: false, error: `${label} must close after it opens.` };
  return { ok: true, value: { is_closed: false, opens: opens.value, closes: closes.value } };
}

// The whole weekly pattern: exactly one entry per weekday 0-6.
export function parseWeek(raw: unknown): Parsed<StoreHours[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "Expected a list of seven days." };
  if (raw.length !== 7) return { ok: false, error: "Send all seven days in one save." };

  const seen = new Set<number>();
  const rows: StoreHours[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object")
      return { ok: false, error: "Each day must be an object." };
    const day = entry as Record<string, unknown>;
    const weekday = Number(day.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
      return { ok: false, error: "Each day needs a weekday from 0 (Sunday) to 6 (Saturday)." };
    if (seen.has(weekday))
      return { ok: false, error: `${WEEKDAY_NAMES[weekday]} was sent twice.` };
    seen.add(weekday);

    const span = parseSpan(day, WEEKDAY_NAMES[weekday]);
    if (!span.ok) return span;
    rows.push({ weekday, ...span.value, updated_at: null });
  }
  return { ok: true, value: rows.sort((a, b) => a.weekday - b.weekday) };
}

// Does a date fall on a weekday whose hours are unset? Used to explain why
// coverage is not being checked yet.
export function weekdaysWithoutHours(hours: StoreHours[]): number[] {
  const have = new Set(hours.map((h) => h.weekday));
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => !have.has(d));
}

// A plain-English description of what one date looks like, given the weekly
// pattern and any exception on it.
export function describeDay(
  hours: StoreHours[],
  exception: StoreHoursException | undefined,
  weekday: number,
): string {
  if (exception) {
    if (exception.is_closed) return "Closed";
    return `${fmtStoreTime(exception.opens)} – ${fmtStoreTime(exception.closes)}`;
  }
  const normal = hours.find((h) => h.weekday === weekday);
  if (!normal) return "Open, normal hours (not set yet)";
  if (normal.is_closed) return `Closed (${WEEKDAY_NAMES[weekday]}s are closed)`;
  return `Open, normal hours (${fmtStoreTime(normal.opens)} – ${fmtStoreTime(normal.closes)})`;
}
