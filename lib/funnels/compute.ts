// Pure funnel computation for the Funnels tab (bj-finance #422).
//
// Everything here operates on plain row arrays (types.ts) and returns plain
// results — no Supabase client, no Date.now() reached for implicitly (the
// caller passes `now`). That is what makes the numbers reconcilable against
// direct SQL and what lets the reviewer trust them without running the app.
//
// The one rule that must never regress: outreach->deal attribution is the
// ACTIVITY JOIN (a prospect was mailed, then a deal on the same email was
// touched AFTER the mail), NEVER a join on deals.created_at. Repeat and legacy
// contacts reuse deal rows, so created_at would credit the machine for deals it
// never touched. See attributeDeals().

import { deriveProfile, PROFILES, type Profile } from "./profile";
import type {
  BelowMinResult,
  DealFunnelRow,
  DealRow,
  Engine,
  OutreachEventRow,
  OutreachFunnel,
  ProspectRow,
  QuoteLatencyPair,
  QuoteLatencyResult,
  QuoteLatencyTrendPoint,
} from "./types";

// --- Stage vocabulary (mirrors lib/stages.ts, verbatim per spec) -------------

const QUOTED_STAGES = new Set([
  "Sent Quote",
  "Booked Unpaid",
  "Booked Paid",
  "Event Complete",
]);
const BOOKED_STAGES = new Set(["Booked Unpaid", "Booked Paid", "Event Complete"]);
const COMPLETE_STAGE = "Event Complete";
const BELOW_MIN_STAGE = "Closed Below Min";

export function reachedQuoted(stage: string): boolean {
  return QUOTED_STAGES.has(stage);
}
export function reachedBooked(stage: string): boolean {
  return BOOKED_STAGES.has(stage);
}

// --- Small helpers -----------------------------------------------------------

export function emailKey(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** deals.created_at / updated_at are stored as ISO text; parse defensively. */
export function parseTs(iso: string | null | undefined): number {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : t;
}

export function dealValue(d: DealRow): number {
  return (
    d.signed_contract_total ?? d.total_with_tax ?? d.subtotal_pretax ?? 0
  );
}

/** Stage-to-stage conversion, guarding divide-by-zero. Rounded to 1 dp %. */
export function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// --- Window filtering --------------------------------------------------------

export function inWindow(iso: string | null | undefined, startMs: number): boolean {
  const t = parseTs(iso);
  return !Number.isNaN(t) && t >= startMs;
}

// --- Outreach (left-of-pipeline) funnel, per engine --------------------------

/**
 * Per engine: sent -> replied -> handed_off -> deal -> quoted -> booked.
 *
 * "sent" counts distinct prospects with a `sequenced` event inside the window.
 * The prospect's mail instant is the EARLIEST such event in the window; deal
 * attribution then requires a same-email deal touched (updated_at) strictly
 * after that instant — the activity join. replied / handed_off count prospects
 * carrying that event at any time (small, event-sparse data; kept simple and
 * honest rather than over-modelled).
 */
export function computeOutreachFunnel(
  events: OutreachEventRow[],
  prospects: ProspectRow[],
  deals: DealRow[],
  windowStartMs: number,
): OutreachFunnel[] {
  const engineOf = new Map<number, Engine>();
  const emailOf = new Map<number, string>();
  for (const p of prospects) {
    if (p.engine === "warm" || p.engine === "cold") engineOf.set(p.id, p.engine);
    emailOf.set(p.id, emailKey(p.email));
  }

  // Earliest in-window mail per prospect, plus event flags per prospect.
  const mailAt = new Map<number, number>();
  const replied = new Set<number>();
  const handedOff = new Set<number>();
  for (const e of events) {
    if (e.prospect_id == null) continue;
    const t = parseTs(e.occurred_at);
    if (e.event === "sequenced" && !Number.isNaN(t) && t >= windowStartMs) {
      const prev = mailAt.get(e.prospect_id);
      if (prev === undefined || t < prev) mailAt.set(e.prospect_id, t);
    } else if (e.event === "replied" || e.event === "interested") {
      replied.add(e.prospect_id);
    } else if (e.event === "handed_off") {
      handedOff.add(e.prospect_id);
    }
  }

  // Deals grouped by email key, with the furthest stage flags and the latest
  // update instant — for the activity join.
  type DealAgg = { updates: number[]; quoted: boolean; booked: boolean };
  const dealsByEmail = new Map<string, DealAgg>();
  for (const d of deals) {
    const k = emailKey(d.contact_email);
    if (!k) continue;
    const agg = dealsByEmail.get(k) ?? { updates: [], quoted: false, booked: false };
    const u = parseTs(d.updated_at);
    if (!Number.isNaN(u)) agg.updates.push(u);
    if (reachedQuoted(d.stage)) agg.quoted = true;
    if (reachedBooked(d.stage)) agg.booked = true;
    dealsByEmail.set(k, agg);
  }

  const engines: Engine[] = ["warm", "cold"];
  return engines.map((engine) => {
    let sent = 0;
    let repliedN = 0;
    let handedN = 0;
    let dealN = 0;
    let quotedN = 0;
    let bookedN = 0;

    for (const [pid, mailTs] of mailAt) {
      if (engineOf.get(pid) !== engine) continue;
      sent += 1;
      if (replied.has(pid)) repliedN += 1;
      if (handedOff.has(pid)) handedN += 1;

      const k = emailOf.get(pid);
      const agg = k ? dealsByEmail.get(k) : undefined;
      // Activity join: a deal on this email touched AFTER the mail instant.
      const touchedAfter = agg?.updates.some((u) => u > mailTs) ?? false;
      if (touchedAfter) {
        dealN += 1;
        if (agg!.quoted) quotedN += 1;
        if (agg!.booked) bookedN += 1;
      }
    }

    return {
      engine,
      sent,
      replied: repliedN,
      handed_off: handedN,
      deal: dealN,
      quoted: quotedN,
      booked: bookedN,
    };
  });
}

// --- Deal funnel, per derived profile ----------------------------------------

/**
 * Deals CREATED in the window, grouped by derived profile plus an `__all__`
 * roll-up: created -> quoted -> booked -> complete, with $ of booked and quoted
 * deals, and the below-min count folded in per profile.
 */
export function computeDealFunnel(
  deals: DealRow[],
  windowStartMs: number,
): DealFunnelRow[] {
  const blank = (): Omit<DealFunnelRow, "profile"> => ({
    created: 0,
    quoted: 0,
    booked: 0,
    complete: 0,
    below_min: 0,
    booked_value: 0,
    quoted_value: 0,
  });

  const rows = new Map<Profile | "__all__", Omit<DealFunnelRow, "profile">>();
  rows.set("__all__", blank());
  for (const p of PROFILES) rows.set(p, blank());

  const bump = (key: Profile | "__all__", d: DealRow) => {
    const r = rows.get(key)!;
    r.created += 1;
    if (reachedQuoted(d.stage)) {
      r.quoted += 1;
      r.quoted_value += dealValue(d);
    }
    if (reachedBooked(d.stage)) {
      r.booked += 1;
      r.booked_value += dealValue(d);
    }
    if (d.stage === COMPLETE_STAGE) r.complete += 1;
    if (d.stage === BELOW_MIN_STAGE) r.below_min += 1;
  };

  for (const d of deals) {
    if (!inWindow(d.created_at, windowStartMs)) continue;
    const profile = deriveProfile(d.event_type, d.contact_email);
    bump("__all__", d);
    bump(profile, d);
  }

  const order: (Profile | "__all__")[] = ["__all__", ...PROFILES];
  return order.map((profile) => ({ profile, ...rows.get(profile)! }));
}

// --- Below-min counter -------------------------------------------------------

export function computeBelowMin(
  deals: DealRow[],
  windowStartMs: number,
): BelowMinResult {
  let overallBelow = 0;
  let overallTotal = 0;
  const per = new Map<Profile, { below_min: number; total: number }>();
  for (const p of PROFILES) per.set(p, { below_min: 0, total: 0 });

  for (const d of deals) {
    if (!inWindow(d.created_at, windowStartMs)) continue;
    const profile = deriveProfile(d.event_type, d.contact_email);
    overallTotal += 1;
    per.get(profile)!.total += 1;
    if (d.stage === BELOW_MIN_STAGE) {
      overallBelow += 1;
      per.get(profile)!.below_min += 1;
    }
  }

  return {
    overall: {
      below_min: overallBelow,
      total: overallTotal,
      share: pct(overallBelow, overallTotal),
    },
    by_profile: PROFILES.map((profile) => {
      const v = per.get(profile)!;
      return {
        profile,
        below_min: v.below_min,
        total: v.total,
        share: pct(v.below_min, v.total),
      };
    }),
  };
}

// --- Quote latency -----------------------------------------------------------

/** ISO week (Monday 00:00 UTC) containing `ms`. */
export function weekStartISO(ms: number): string {
  const d = new Date(ms);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  const monday = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - diff,
  );
  return new Date(monday).toISOString();
}

/**
 * Median hours from deal-created to quote-produced, overall and trended by the
 * week the deal was created in. Pairs whose timestamps do not parse, or whose
 * quote precedes creation, are dropped (a negative latency is data noise, not a
 * real speed-to-lead reading).
 */
export function computeQuoteLatency(
  pairs: QuoteLatencyPair[],
  windowStartMs: number,
): QuoteLatencyResult {
  const clean: { createdMs: number; hours: number }[] = [];
  for (const p of pairs) {
    const c = parseTs(p.created_at);
    const q = parseTs(p.quote_sent_at);
    if (Number.isNaN(c) || Number.isNaN(q)) continue;
    if (c < windowStartMs) continue;
    const hours = (q - c) / (1000 * 60 * 60);
    if (hours < 0) continue;
    clean.push({ createdMs: c, hours });
  }

  const byWeek = new Map<string, number[]>();
  for (const r of clean) {
    const wk = weekStartISO(r.createdMs);
    (byWeek.get(wk) ?? byWeek.set(wk, []).get(wk)!).push(r.hours);
  }

  const trend: QuoteLatencyTrendPoint[] = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week_start, hrs]) => ({
      week_start,
      median_hours: round1(median(hrs)),
      count: hrs.length,
    }));

  return {
    median_hours: round1(median(clean.map((r) => r.hours))),
    count: clean.length,
    trend,
  };
}

function round1(v: number | null): number | null {
  if (v === null) return null;
  return Math.round(v * 10) / 10;
}
