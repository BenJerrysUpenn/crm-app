// The pay table on the payroll page (bj-finance #519, Alina 2026-10-05).
//
// "That submit button allows for no verification of actual payroll numbers or
// checks. Who is getting paid what? How do I know the hourly rates match hours
// worked? That solo close was calculated correctly? I need a table that matches
// QBO for each person."
//
// The numbers are bj-finance modules/payroll_sheet.py's, built on the Mac and
// published to public.payroll_sheets (migration 36) as the sheet's JSON. This
// file computes NO pay: it types that JSON, orders QBO's columns, says what
// state the latest build or request is in, and decides whether the pay table
// lets the run be submitted. Pure and dependency-free so `node --test` runs it,
// and the page, its API route and the submit route all apply the same rules.

import { addDays, type PayWindow } from "./window.ts";
import type { AuditRow } from "./verify.ts";

// ---------- the published sheet (render_json, up to sheet_version 4) ----------

export type SheetPunch = {
  id: number;
  date: string;
  clock_in: string;
  clock_out: string | null;
  paid_from: string;
  paid_to: string;
  hours: number;
  manual: boolean;
  anomalies: string[];
  shift: { id: number; position: string; starts_at: string; ends_at: string } | null;
};

export type SheetCateringEvent = {
  deal_id: number | null;
  event_date: string;
  company: string | null;
  cents: number;
  crew_evidence?: string;
  late?: boolean;
  paid_on?: string | null;
};

/** One workweek's overtime owed on the catering premium. */
export type SheetPremiumOvertime = {
  week_start: string;
  week_end: string;
  week_hours: number;
  overtime_hours: number;
  cents: number;
};

export type SheetRow = {
  person: string;
  display: string;
  qbo_employee_id: string | null;
  salaried: boolean;
  hours: number;
  overtime_hours: number;
  regular_hours?: number;
  offcycle_hours: number;
  hours_owed: number;
  pool_cents: number;
  catering_cents: number;
  olo_cents: number;
  tips_cents: number;
  solo_close_cents: number;
  travel_cents: number;
  pay_type: string | null;
  hourly_rate: number | null;
  wages_cents?: number | null;
  wages_basis?: "hourly" | "salary" | "no_rate";
  /** No column on the page (the owner, 2026-11-02). The expanded row still shows them: the premium needs them. */
  catering_hours: number;
  premium_hours: number;
  /** The whole Catering premium line. From the 2026-10-19 period, any overtime on the premium is inside it. */
  premium_cents: number;
  /** A separate overtime line on a period before 2026-10-19. Empty or missing from then on. */
  premium_ot_cents?: number;
  premium_ot?: SheetPremiumOvertime[];
  /** Marketing labour, booked as a marketing cost too (the 2% obligation). Not a pay line. */
  marketing_hours?: number;
  marketing_cents?: number;
  evidence: {
    punch_ids: number[];
    punches?: SheetPunch[];
    week_hours: number[];
    in_store_hours: number;
    off_site_hours: number;
    raw_hours: number;
    solo_close_nights: string[];
    solo_close_by_choice: string[];
    pool_rule: string;
    catering_events: SheetCateringEvent[];
    pastry_shifts_covered: number;
    /** Why this row has its Olo tips, when bake shifts are not the reason (bj-finance, from 2026-10-19). */
    olo_evidence?: string;
    /** How the premium was worked out, when overtime is inside it (bj-finance, from 2026-10-19). */
    premium_base_cents?: number;
    premium_overtime?: SheetPremiumOvertime[];
    owner: boolean;
  };
};

export type SheetSoloNight = {
  night: string;
  person: string;
  display?: string;
  closed_at: string;
  tail_hours: number;
  awarded: boolean;
  cents: number;
  routed: boolean;
  reason: string;
};

export type SheetItem = { code: string; clause: string; message: string };

export type PaySheetJson = {
  sheet_version?: number;
  window: { start: string; end: string; pay_date: string; weeks: [string, string][] };
  pool_rule: string;
  rows: SheetRow[];
  totals: {
    hours: number;
    overtime_hours: number;
    regular_hours?: number;
    wages_cents?: number;
    wages_unpriced?: string[];
    tips_cents: number;
    solo_close_cents: number;
    travel_cents: number;
    catering_hours?: number;
    premium_cents: number;
    premium_ot_cents?: number;
    marketing_hours?: number;
    marketing_cents?: number;
  };
  solo_close_nights: SheetSoloNight[];
  open_items: SheetItem[];
  flags: SheetItem[];
};

/** The version of render_json this page is written for. */
export const SHEET_VERSION = 2;

// ---------- payroll_sheets rows -------------------------------------------------

export type PaySheetStatus = "queued" | "building" | "built" | "failed";

/** A payroll_sheets row without its sheet: a request, or a build's header. */
export type PaySheetMeta = {
  id: number;
  window_end: string;
  status: PaySheetStatus;
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  built_at: string | null;
  built_by: string | null;
  source_fingerprint: string | null;
  open_items: number | null;
  error: string | null;
};

export type PaySheetBuild = PaySheetMeta & { status: "built"; sheet: PaySheetJson; started_at: string };

/** Everything the page and the submit route need about one period's pay table. */
export type PaySheetState =
  | { available: false; reason: string }
  | {
      available: true;
      /** The latest BUILT row for the period, with its sheet. */
      built: PaySheetBuild | null;
      /** The latest row of any status: what the Rebuild button last did. */
      latest: PaySheetMeta | null;
      /** The latest change to a punch, shift or choice bearing on the period. */
      changedAt: string | null;
      /** Builds kept for the period. */
      builds: number;
    };

/** Columns read for a row without its (large) sheet. */
export const META_COLUMNS =
  "id, window_end, status, requested_by, requested_at, started_at, built_at, built_by, source_fingerprint, open_items, error";

// ---------- QBO's Run Payroll grid ---------------------------------------------

export type PayTableColumn = {
  key:
    | "regular"
    | "overtime"
    | "tips"
    | "solo"
    | "premium"
    | "marketing_hours"
    | "marketing"
    | "travel";
  /** QBO's pay line, as it is named on the grid, or the info column's name. */
  label: string;
  /** A pay line keyed into QBO; false for a column shown for information only. */
  qbo: boolean;
};

/**
 * The pay table's columns. The pay lines are in the order they are keyed into
 * QBO's Run Payroll grid (bj-finance reports/biweekly/BIWEEKLY-01_payroll-run.md,
 * spec §5/§6): hours first, then the flat amounts. Travel is the non-taxable
 * Travel Reimbursement line. The page adds the rate and the wages after these.
 *
 * Two columns are information only, never keyed and never in a pay total:
 * Marketing hours and Marketing cost (2026-10-12): marketing labour is booked
 * as a marketing cost toward the 2% marketing obligation on top of being
 * payroll. They follow the Catering premium. A salaried row shows its hours and
 * no cost from the 2026-10-19 period, because the sheet publishes none
 * (the owner, 2026-11-02).
 *
 * Catering hours and Catering premium OT were columns until the owner's rulings
 * of 2026-11-02: "I only need Catering premium not catering hours" and "Catering
 * premium OT isn't a thing". The expanded row still shows how a premium was
 * worked out (premiumDetailText).
 */
export const PAY_TABLE_COLUMNS: PayTableColumn[] = [
  { key: "regular", label: "Regular hours", qbo: true },
  { key: "overtime", label: "Overtime hours", qbo: true },
  { key: "tips", label: "Paycheck tips", qbo: true },
  { key: "solo", label: "Solo close", qbo: true },
  { key: "premium", label: "Catering premium", qbo: true },
  { key: "marketing_hours", label: "Marketing hours", qbo: false },
  { key: "marketing", label: "Marketing cost", qbo: false },
  { key: "travel", label: "Travel reimbursement", qbo: true },
];

/** The pay lines alone, in QBO's keying order. */
export const QBO_COLUMNS: PayTableColumn[] = PAY_TABLE_COLUMNS.filter((c) => c.qbo);

// ---------- formatting (no arithmetic on pay) ----------------------------------

/** 12345 → "$123.45". Cents are integers in the sheet; this only formats. */
export function money(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

export function hoursText(hours: number | null | undefined): string {
  return hours == null ? "—" : hours.toFixed(2);
}

/** One cell for a row, as the person keying it would type it. */
export function qboCell(row: SheetRow, key: PayTableColumn["key"]): string {
  switch (key) {
    case "regular":
      return row.salaried ? "salary" : hoursText(row.regular_hours ?? row.hours_owed);
    case "overtime":
      return row.salaried ? "" : row.overtime_hours ? hoursText(row.overtime_hours) : "";
    case "tips":
      return row.tips_cents ? money(row.tips_cents) : "";
    case "solo":
      return row.solo_close_cents ? money(row.solo_close_cents) : "";
    case "premium":
      return row.premium_cents ? money(row.premium_cents) : "";
    case "marketing_hours":
      return row.marketing_hours ? hoursText(row.marketing_hours) : "";
    case "marketing":
      return row.marketing_cents ? money(row.marketing_cents) : "";
    case "travel":
      return row.travel_cents ? money(row.travel_cents) : "";
  }
}

/**
 * The totals row's cell for a column. A sheet built before marketing was
 * published leaves the marketing totals blank.
 */
export function qboTotal(totals: PaySheetJson["totals"], key: PayTableColumn["key"]): string {
  switch (key) {
    case "regular":
      return hoursText(totals.regular_hours ?? totals.hours);
    case "overtime":
      return hoursText(totals.overtime_hours);
    case "tips":
      return money(totals.tips_cents);
    case "solo":
      return money(totals.solo_close_cents);
    case "premium":
      return money(totals.premium_cents);
    case "marketing_hours":
      return totals.marketing_hours == null ? "" : hoursText(totals.marketing_hours);
    case "marketing":
      return totals.marketing_cents == null ? "" : money(totals.marketing_cents);
    case "travel":
      return money(totals.travel_cents);
  }
}

/**
 * How a row's Catering premium was worked out, for its expanded detail. From
 * the 2026-10-19 period any overtime on the premium is inside the one amount
 * and the sheet says how much; an earlier period's separate line reads as it
 * always did. Every figure is the sheet's own.
 */
export function premiumDetailText(row: SheetRow): string {
  const inside = row.evidence.premium_overtime ?? [];
  const parts = [`Premium hours ${hoursText(row.premium_hours)}h → ${money(row.evidence.premium_base_cents ?? row.premium_cents)}`];
  for (const l of inside) parts.push(`overtime on the premium ${l.week_start}–${l.week_end}: ${money(l.cents)}`);
  if (inside.length > 0) parts.push(`Catering premium ${money(row.premium_cents)}, with that overtime inside it`);
  for (const l of row.premium_ot ?? []) parts.push(`premium OT ${l.week_start}–${l.week_end}: ${money(l.cents)}`);
  return parts.join(" · ");
}

/**
 * A pay table built for a period before 2026-10-19 can carry a separate
 * premium overtime amount, which has no column now. Say so under the table
 * rather than let the money drop out of sight. Null when there is none.
 */
export function separatePremiumOtNote(totals: PaySheetJson["totals"]): string | null {
  if (!totals.premium_ot_cents) return null;
  return `This pay table also has ${money(totals.premium_ot_cents)} of premium overtime on its own line, shown when you open the row.`;
}

/** The wages cell: a figure, "salary", or why there is none. */
export function wagesCell(row: SheetRow): string {
  if (row.salaried || row.wages_basis === "salary") return "salary";
  if (row.wages_basis === "no_rate" || row.hourly_rate == null) return "no rate";
  return money(row.wages_cents ?? null);
}

export function rateCell(row: SheetRow): string {
  if (row.salaried) return "salary";
  return row.hourly_rate == null ? "no rate" : `$${row.hourly_rate.toFixed(2)}/h`;
}

// ---------- staleness: what bears on the period ----------------------------------

/** "YYYY-MM-DD HH:MM:SS" in New York, which sorts as text. */
export function nyStamp(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", { timeZone: "America/New_York", hour12: false });
}

/**
 * Microseconds since the epoch, keeping what Date drops: Postgres stamps carry
 * microseconds, and two writes a few hundred of them apart are still ordered.
 */
export function micros(iso: string): number {
  const m = /\.(\d+)/.exec(iso);
  const frac = m ? m[1].padEnd(6, "0").slice(0, 6) : "000000";
  const whole = Date.parse(iso.replace(/\.\d+/, ""));
  return whole * 1000 + Number(frac);
}

function inPadding(stamp: unknown, window: PayWindow): boolean {
  if (typeof stamp !== "string") return false;
  const at = nyStamp(stamp);
  return at >= `${addDays(window.start, -1)} 00:00:00` && at < `${addDays(window.end, 1)} 05:00:00`;
}

function rulingBears(img: Record<string, unknown>, window: PayWindow): boolean {
  if (img.window_end === window.end) return true;
  const day = typeof img.case_date === "string" ? img.case_date.slice(0, 10) : null;
  return day != null && day >= window.start && day <= window.end;
}

export type RulingStamp = { window_end: string; case_date: string | null; decided_at: string; created_at?: string | null };

/**
 * The latest write that bears on the period, or null. Migration 36's
 * payroll_inputs_changed_at() is the database's copy of this rule:
 *   * a punch (time_entries.clock_in_at) or shift (shifts.starts_at), before or
 *     after the write, from 00:00 New York the day before the period up to
 *     05:00 the day after it — an overnight close, and the morning clock-in
 *     that closes a forgotten punch, land in that padding; a Monday punch at
 *     the counter does not;
 *   * a choice (payroll_rulings) made from the period or dated inside it,
 *     including one reset to its default (a DELETE, audited from migration 36).
 */
export function inputsChangedAt(window: PayWindow, audits: AuditRow[], rulings: RulingStamp[] = []): string | null {
  let latest: string | null = null;
  const consider = (at: string | null | undefined) => {
    if (at && (latest == null || micros(at) > micros(latest))) latest = at;
  };
  for (const a of audits) {
    const images = [a.before_image, a.after_image].filter((i): i is Record<string, unknown> => !!i);
    const bears = images.some((img) =>
      a.table_name === "time_entries"
        ? inPadding(img.clock_in_at, window)
        : a.table_name === "shifts"
          ? inPadding(img.starts_at, window)
          : a.table_name === "payroll_rulings"
            ? rulingBears(img, window)
            : false,
    );
    if (bears) consider(a.at);
  }
  for (const r of rulings) {
    if (rulingBears(r as unknown as Record<string, unknown>, window)) {
      consider(r.decided_at);
      consider(r.created_at ?? null);
    }
  }
  return latest;
}

// ---------- the gate --------------------------------------------------------------

const NY_TIME: Intl.DateTimeFormatOptions = {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

export function whenText(iso: string): string {
  return new Date(iso).toLocaleString("en-US", NY_TIME);
}

/**
 * Why the pay table does not let this run be submitted, or null when it does.
 * Conditions (b)-(d) of the submit gate (Alina, 2026-10-05); (a), nothing left
 * to fix in Verify, is submittalBlocker's. Migration 36's submittal guard
 * refuses the same three.
 */
export function payTableBlocker(state: PaySheetState): string | null {
  if (!state.available) return `The pay table is not available yet: ${state.reason}`;
  const built = state.built;
  if (!built) return "Build the pay table for this period first (Rebuild pay table, above), and check it.";
  const open = built.open_items ?? built.sheet.open_items.length;
  if (open > 0)
    return `The pay table has ${open} open item${open === 1 ? "" : "s"}. Fix ${open === 1 ? "it" : "them"} in the app, then rebuild the pay table.`;
  if (state.changedAt && micros(state.changedAt) > micros(built.started_at))
    return `A punch, shift or choice for this period changed at ${whenText(state.changedAt)}, after the pay table was built from the data as of ${whenText(built.started_at)}. Rebuild the pay table, then check it again.`;
  return null;
}

// ---------- what the Rebuild button last did ---------------------------------------

export type RequestView = { tone: "busy" | "ok" | "error" | "none"; text: string };

export function requestView(state: PaySheetState): RequestView {
  if (!state.available) return { tone: "none", text: "" };
  const latest = state.latest;
  if (!latest) return { tone: "none", text: "No pay table has been built for this period." };
  switch (latest.status) {
    case "queued":
      return {
        tone: "busy",
        text: `Queued ${whenText(latest.requested_at)}. The Mac builds it within a minute or two if it is awake.`,
      };
    case "building":
      return { tone: "busy", text: `Building since ${whenText(latest.started_at ?? latest.requested_at)}…` };
    case "built":
      return { tone: "ok", text: `Built ${whenText(latest.built_at ?? latest.requested_at)}.` };
    case "failed":
      return { tone: "error", text: `The last build failed: ${latest.error ?? "no error was recorded"}.` };
  }
}

/** Is a build in flight, so the page should look again shortly? */
export function inFlight(state: PaySheetState): boolean {
  return state.available && (state.latest?.status === "queued" || state.latest?.status === "building");
}

/**
 * What the row's Olo line says after the amount. The sheet names the reason from
 * the period starting 2026-10-19, when bake shifts no longer decide the Olo tips
 * (ruled 2026-11-02); an earlier sheet carries only the bake-shift count.
 */
export function oloEvidenceText(row: Pick<SheetRow, "olo_cents" | "evidence">): string {
  if (row.olo_cents <= 0) return "";
  if (row.evidence.olo_evidence) return ` · ${row.evidence.olo_evidence}`;
  const n = row.evidence.pastry_shifts_covered;
  return ` over ${n} Pastry Opener shift${n === 1 ? "" : "s"}`;
}
