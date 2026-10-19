// The control board's settings (bj-finance #693, lane #692): which values the
// owners set, in what units, and how a dated history of them is read.
//
// Storage is migration 43: public.control_settings holds one row per value as
// it was set (a change is a new row), public.profile_salaries the same for a
// salaried person's annual salary. The value in force on a day is the row
// with the latest effective_from on or before that day; rows with the same
// effective_from (a same-day correction) resolve to the later recorded_at,
// then the higher id. inForce() below and the database's
// control_settings_on() say the same thing; bj-finance reads the latter.
//
// A new board category is new entries in SETTINGS (and lines in board.ts),
// never a migration. Nothing here holds a business figure: crm-app is public,
// and the owners enter every value on the board.
//
// Pure and dependency-free, so `node --test` runs it and the route and the
// page validate identically.

/** How a number is entered and shown. Shares are stored as fractions (0.25 is 25%). Minutes are whole minutes. */
export type FieldKind = "pct" | "money" | "per100" | "hours" | "minutes" | "time" | "text";

export type FieldSpec = {
  /** "value" for the row's main number, otherwise the name of its key in `detail`. */
  name: string;
  kind: FieldKind;
  /** Decimal places shown and kept in a box. */
  digits: number;
  label: string;
  before?: string;
  after?: string;
  /** May be left blank (stored as null): a wage cap left blank means "on all wages". */
  optional?: boolean;
  /** Shown in the line's row on the board as well as in its sidebar. */
  inline?: boolean;
};

export type SettingSpec = {
  key: string;
  label: string;
  /** The unit of `value`, in words, for the README and for bj-finance. */
  unit: string;
  fields: FieldSpec[];
};

const pctField = (label: string, digits = 2): FieldSpec => ({ name: "value", kind: "pct", digits, label, inline: true });
const capField = (label: string): FieldSpec => ({
  name: "wage_cap", kind: "money", digits: 0, label: `${label} wage cap`, before: "on the first", optional: true, inline: true,
});

/** Every setting the board stores, by key. The order is the board's order within a category. */
export const SETTINGS: SettingSpec[] = [
  { key: "sales_estimate.in_store", label: "In-store sales estimate", unit: "dollars over the next 12 months", fields: [{ name: "value", kind: "money", digits: 2, label: "In-store sales", inline: true }] },
  { key: "sales_estimate.catering", label: "Catering sales estimate", unit: "dollars over the next 12 months", fields: [{ name: "value", kind: "money", digits: 2, label: "Catering sales", inline: true }] },
  { key: "target.cogs_pct", label: "COGS target", unit: "fraction of sales", fields: [pctField("COGS target")] },
  { key: "target.payroll_pct", label: "Total payroll target", unit: "fraction of sales", fields: [pctField("Total payroll target")] },
  { key: "target.prime_cost_pct", label: "Prime cost target", unit: "fraction of sales", fields: [pctField("Prime cost target")] },
  { key: "tax.fica", label: "FICA (employer share)", unit: "fraction of wages; detail.wage_cap dollars a year or null", fields: [pctField("FICA rate", 3), capField("FICA")] },
  { key: "tax.futa", label: "Federal unemployment (FUTA)", unit: "fraction of wages; detail.wage_cap dollars a year or null", fields: [pctField("FUTA rate", 3), capField("FUTA")] },
  { key: "tax.pa_uc", label: "PA unemployment (UC)", unit: "fraction of wages; detail.wage_cap dollars a year or null", fields: [pctField("PA UC rate", 3), capField("PA UC")] },
  {
    key: "tax.workers_comp", label: "Workers' comp", unit: "dollars per $100 of wages; detail.class_code text",
    fields: [
      { name: "value", kind: "per100", digits: 3, label: "Workers' comp per $100 of wages", after: "per $100 of wages", inline: true },
      { name: "class_code", kind: "text", digits: 0, label: "Policy class code", optional: true },
    ],
  },
  {
    key: "rule.catering_premium", label: "Catering premium", unit: "dollars added per catering hour; detail.cap_rate dollars an hour",
    fields: [
      { name: "value", kind: "money", digits: 2, label: "Catering premium per hour", before: "+", after: "/hr", inline: true },
      { name: "cap_rate", kind: "money", digits: 2, label: "Catering pay cap per hour", before: "up to", after: "/hr", inline: true },
    ],
  },
  {
    key: "rule.solo_close", label: "Solo-close bonus", unit: "dollars a qualifying night; detail.min_alone_hours hours, detail.out_at_or_after HH:MM",
    fields: [
      { name: "value", kind: "money", digits: 2, label: "Solo-close bonus per night", after: "a night", inline: true },
      { name: "min_alone_hours", kind: "hours", digits: 2, label: "Closer alone at least", after: "hours" },
      { name: "out_at_or_after", kind: "time", digits: 0, label: "Clocks out at or after" },
    ],
  },
  // Staffed hours (bj-finance #742 follow-up, ruled 2026-10-19): the open hours
  // widened by these minutes are what coverage is measured against
  // (staffedWindow in lib/coverage.ts, which names the same two keys).
  {
    key: "staffing.open_up_minutes", label: "Open-up time", unit: "minutes before opening that someone must be in the store",
    fields: [{ name: "value", kind: "minutes", digits: 0, label: "Open-up time", after: "minutes before opening", inline: true }],
  },
  {
    key: "staffing.close_down_minutes", label: "Close-down time", unit: "minutes after closing that someone must be in the store",
    fields: [{ name: "value", kind: "minutes", digits: 0, label: "Close-down time", after: "minutes after closing", inline: true }],
  },
];

export const SETTING_KEYS = SETTINGS.map((s) => s.key);

export function settingSpec(key: string): SettingSpec | undefined {
  return SETTINGS.find((s) => s.key === key);
}

// ---------------------------------------------------------------------------
// Stored rows and the value in force
// ---------------------------------------------------------------------------

export type Detail = Record<string, number | string | null>;

/** A row of public.control_settings, as the page reads it. */
export type SettingRow = {
  id: number;
  key: string;
  value: number;
  detail: Detail;
  effective_from: string;
  review_by: string;
  source: string;
  method: string | null;
  recorded_by: string | null;
  recorded_at: string;
};

/** A row of public.profile_salaries, as the page reads it. */
export type SalaryRow = {
  id: number;
  profile_id: string;
  annual_salary: number;
  effective_from: string;
  review_by: string;
  source: string;
  method: string | null;
  recorded_by: string | null;
  recorded_at: string;
};

type Dated = { id: number; effective_from: string; recorded_at: string };

/** Newest first: later effective_from, then later recorded_at, then higher id. */
export function newestFirst<T extends Dated>(a: T, b: T): number {
  if (a.effective_from !== b.effective_from) return a.effective_from < b.effective_from ? 1 : -1;
  if (a.recorded_at !== b.recorded_at) return a.recorded_at < b.recorded_at ? 1 : -1;
  return b.id - a.id;
}

/** The row in force on `day` among `rows` (all for one key or person), or null. */
export function inForce<T extends Dated>(rows: T[], day: string): T | null {
  return [...rows].filter((r) => r.effective_from <= day).sort(newestFirst)[0] ?? null;
}

/** All of one key's rows, newest first: the line's history. */
export function historyOf<T extends Dated>(rows: T[]): T[] {
  return [...rows].sort(newestFirst);
}

/** Group rows by a column (key or profile_id). */
export function groupBy<T, K extends keyof T>(rows: T[], col: K): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = String(r[col]);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** The row in force today for every key that has one. */
export function settingsInForce(rows: SettingRow[], day: string): Map<string, SettingRow> {
  const out = new Map<string, SettingRow>();
  for (const [key, list] of groupBy(rows, "key")) {
    const row = inForce(list, day);
    if (row) out.set(key, row);
  }
  return out;
}

/**
 * A pay rule (a `rule.*` key) as it stood on `day`. A rule that has rows but
 * none starting on or before `day` did not exist yet: it paid nothing then
 * ("not yet", a real zero). A rule with no rows at all has never been set and
 * is missing ("unset"). Rates, taxes and targets do not work this way: for
 * them no row in force is always missing (bj-finance #696, 2026-10-16).
 */
export type RuleOn = { state: "in_force"; row: SettingRow } | { state: "not_yet" } | { state: "unset" };

export function ruleOn(rows: SettingRow[], key: string, day: string): RuleOn {
  const mine = rows.filter((r) => r.key === key);
  if (!mine.length) return { state: "unset" };
  const row = inForce(mine, day);
  return row ? { state: "in_force", row } : { state: "not_yet" };
}

// ---------------------------------------------------------------------------
// The review-by chip
// ---------------------------------------------------------------------------

export type ReviewState = "ok" | "soon" | "overdue";

/** `day` plus n calendar months (the 31st of a short month rolls into the next, as Date does). */
export function addMonthsTo(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** Green while review-by is more than a month off, yellow within a month of it, red once it has passed. */
export function reviewState(reviewBy: string, today: string): ReviewState {
  if (today > reviewBy) return "overdue";
  if (addMonthsTo(today, 1) >= reviewBy) return "soon";
  return "ok";
}

// ---------------------------------------------------------------------------
// Validating what an owner submits
// ---------------------------------------------------------------------------

export const MAX_NOTE = 2000;
/** The most a minutes value may be: four hours. */
export const MAX_MINUTES = 240;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** One field of a submitted value, checked against its kind. */
export function parseField(f: FieldSpec, raw: unknown): Parsed<number | string | null> {
  if (raw === null || raw === undefined || raw === "") {
    return f.optional ? { ok: true, value: null } : { ok: false, error: `${f.label} is required.` };
  }
  if (f.kind === "text") {
    if (typeof raw !== "string") return { ok: false, error: `${f.label} must be text.` };
    const t = raw.trim();
    if (t.length > 40) return { ok: false, error: `${f.label} is at most 40 characters.` };
    return t === "" && f.optional ? { ok: true, value: null } : { ok: true, value: t };
  }
  if (f.kind === "time") {
    if (typeof raw !== "string" || !TIME_RE.test(raw.trim())) return { ok: false, error: `${f.label} must be a time as HH:MM (24-hour).` };
    return { ok: true, value: raw.trim() };
  }
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[$,%\s]/g, "")) : NaN;
  if (!Number.isFinite(n)) return { ok: false, error: `${f.label} must be a number.` };
  if (n < 0) return { ok: false, error: `${f.label} cannot be negative.` };
  if (f.kind === "pct" && n > 1) return { ok: false, error: `${f.label} is a share: at most 100%.` };
  if (f.kind === "hours" && (n <= 0 || n > 24)) return { ok: false, error: `${f.label} must be between 0 and 24 hours.` };
  if (f.kind === "minutes" && (!Number.isInteger(n) || n > MAX_MINUTES)) return { ok: false, error: `${f.label} must be whole minutes, from 0 to ${MAX_MINUTES}.` };
  if (f.name === "wage_cap" && n === 0) return { ok: false, error: `${f.label}: leave it blank for "on all wages", or give the cap.` };
  return { ok: true, value: n };
}

type Note = { effective_from: string; review_by: string; source: string; method: string | null };

/** The dates and notes every dated value carries. */
export function parseNote(body: Record<string, unknown>): Parsed<Note> {
  if (!isDay(body.effective_from)) return { ok: false, error: "The as-of date must be a date (YYYY-MM-DD)." };
  if (!isDay(body.review_by)) return { ok: false, error: "The review-by date must be a date (YYYY-MM-DD)." };
  if (body.review_by < body.effective_from) return { ok: false, error: "The review-by date cannot be before the as-of date." };
  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!source) return { ok: false, error: "Say where the value came from." };
  if (source.length > MAX_NOTE) return { ok: false, error: `Where it came from is at most ${MAX_NOTE} characters.` };
  const method = typeof body.method === "string" ? body.method.trim() : "";
  if (method.length > MAX_NOTE) return { ok: false, error: `How it was worked out is at most ${MAX_NOTE} characters.` };
  return { ok: true, value: { effective_from: body.effective_from, review_by: body.review_by, source, method: method || null } };
}

export type SettingInsert = Note & { key: string; value: number; detail: Detail };

/** A new dated value for a setting, as POST /api/payroll/targets receives it. */
export function parseSettingInput(body: unknown): Parsed<SettingInsert> {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a JSON body." };
  const b = body as Record<string, unknown>;
  const spec = typeof b.key === "string" ? settingSpec(b.key) : undefined;
  if (!spec) return { ok: false, error: "Unknown setting." };
  const given = (b.detail && typeof b.detail === "object" ? b.detail : {}) as Record<string, unknown>;
  let value = 0;
  const detail: Detail = {};
  for (const f of spec.fields) {
    const p = parseField(f, f.name === "value" ? b.value : given[f.name]);
    if (!p.ok) return p;
    if (f.name === "value") value = p.value as number;
    else detail[f.name] = p.value;
  }
  const note = parseNote(b);
  if (!note.ok) return note;
  return { ok: true, value: { key: spec.key, value, detail, ...note.value } };
}

export type SalaryInsert = Note & { profile_id: string; annual_salary: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A new dated salary, as POST /api/payroll/targets/salary receives it. */
export function parseSalaryInput(body: unknown): Parsed<SalaryInsert> {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a JSON body." };
  const b = body as Record<string, unknown>;
  if (typeof b.profile_id !== "string" || !UUID_RE.test(b.profile_id)) return { ok: false, error: "Which person?" };
  const amount = parseField({ name: "value", kind: "money", digits: 2, label: "Annual salary" }, b.annual_salary);
  if (!amount.ok) return amount;
  const note = parseNote(b);
  if (!note.ok) return note;
  return { ok: true, value: { profile_id: b.profile_id, annual_salary: Math.round((amount.value as number) * 100) / 100, ...note.value } };
}
