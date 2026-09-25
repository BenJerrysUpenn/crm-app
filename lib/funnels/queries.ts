// Server-side data access for the Funnels tab (bj-finance #422).
//
// Runs as the SIGNED-IN user through the SSR client, exactly like the call desk
// (app/api/call-desk/queue/route.ts): the outreach tables are gated by the
// manager RLS policies from supabase/crm/001_call_desk.sql, `deals` by its own
// is_manager() policy, and quote_jobs by its authenticated policy. No admin /
// service-role client — this pass is pure reads a manager is already allowed to
// make, nothing that needs to bypass RLS.
//
// All the arithmetic lives in compute.ts; this file only fetches the minimal
// row projections and hands them over. Small tables (deals 294 active,
// non-`added` outreach events a few hundred), so we pull rows and compute in TS
// rather than pushing aggregation into a view we are not allowed to create yet.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeBelowMin,
  computeDealFunnel,
  computeOutreachFunnel,
  computeQuoteLatency,
  parseTs,
} from "./compute";
import type {
  DealRow,
  Engine,
  FunnelPayload,
  OutreachEventRow,
  ProspectRow,
  QuoteLatencyPair,
} from "./types";
import { parseWindow, windowStart, type WindowKey } from "./windows";

// Page size for range reads; deals and non-added events are both well under a
// couple thousand rows, so a single 5000-row page covers them.
const PAGE = 5000;

const DEAL_COLUMNS =
  "id,stage,contact_email,event_type,created_at,updated_at,total_with_tax,subtotal_pretax,signed_contract_total";

export type LoopStatus = {
  warm: {
    sent_today: number;
    daily_cap: number;
    sequenced_active: number;
    last_activity_at: string | null;
  };
  cold: {
    gate_passed: boolean;
    gate_date: string;
    queued: number;
  };
  quote_jobs: {
    pending: number;
    running: number;
    error: number;
    done_recent: number;
  };
  suppression: {
    total: number;
    opt_out_events: number;
    prospects_total: number;
  };
  generated_at: string;
};

// The warm engine's configured daily cap (OUTREACH_DAILY_CAP on the droplet).
// Surfaced as a constant with a note in the UI because Vercel cannot read the
// droplet env — a proposed sweep_runs table would carry the live value.
export const WARM_DAILY_CAP = 20;
// The cold-lane domain-age gate date (issue #422 reframe). Now in the past.
export const COLD_GATE_DATE = "2026-09-24";

// --- helpers -----------------------------------------------------------------

async function count(
  supabase: SupabaseClient,
  table: string,
  apply: (q: any) => any,
): Promise<number> {
  const q = apply(supabase.from(table).select("*", { count: "exact", head: true }));
  const { count: c, error } = await q;
  if (error) throw error;
  return c ?? 0;
}

/** Start of "today" in America/New_York as an ISO instant. */
export function easternDayStartISO(now: Date): string {
  // Format the date parts in ET, then reinterpret midnight ET as UTC by
  // measuring the offset. Good enough for a "sends today" counter.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  // ET is UTC-4 (DST) or UTC-5. Compute the offset for this instant.
  const asUTC = Date.parse(`${y}-${m}-${d}T00:00:00Z`);
  const etNow = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const localNow = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = localNow.getTime() - etNow.getTime();
  return new Date(asUTC + offsetMs).toISOString();
}

// --- panel 1 + 4: loop status & health --------------------------------------

export async function fetchLoopStatus(
  supabase: SupabaseClient,
  now: Date,
): Promise<LoopStatus> {
  const dayStart = easternDayStartISO(now);

  const [
    sentToday,
    sequencedActive,
    coldQueued,
    jobsPending,
    jobsRunning,
    jobsError,
    suppressionTotal,
    optOutEvents,
    prospectsTotal,
  ] = await Promise.all([
    count(supabase, "outreach_events", (q) =>
      q.eq("event", "sequenced").gte("occurred_at", dayStart),
    ),
    count(supabase, "outreach_prospects", (q) =>
      q.eq("engine", "warm").eq("status", "sequenced"),
    ),
    count(supabase, "outreach_prospects", (q) =>
      q.eq("engine", "cold").eq("status", "queued"),
    ),
    count(supabase, "quote_jobs", (q) => q.eq("status", "pending")),
    count(supabase, "quote_jobs", (q) => q.eq("status", "running")),
    count(supabase, "quote_jobs", (q) => q.eq("status", "error")),
    count(supabase, "outreach_suppression", (q) => q),
    count(supabase, "outreach_events", (q) =>
      q.in("event", ["unsubscribed", "complained"]),
    ),
    count(supabase, "outreach_prospects", (q) => q),
  ]);

  // Last engine activity: newest outreach event that is not the initial import.
  const { data: lastEvt } = await supabase
    .from("outreach_events")
    .select("occurred_at")
    .neq("event", "added")
    .order("occurred_at", { ascending: false })
    .limit(1);

  return {
    warm: {
      sent_today: sentToday,
      daily_cap: WARM_DAILY_CAP,
      sequenced_active: sequencedActive,
      last_activity_at: lastEvt?.[0]?.occurred_at ?? null,
    },
    cold: {
      gate_passed: now >= new Date(`${COLD_GATE_DATE}T23:59:59Z`),
      gate_date: COLD_GATE_DATE,
      queued: coldQueued,
    },
    quote_jobs: {
      pending: jobsPending,
      running: jobsRunning,
      error: jobsError,
      done_recent: 0,
    },
    suppression: {
      total: suppressionTotal,
      opt_out_events: optOutEvents,
      prospects_total: prospectsTotal,
    },
    generated_at: now.toISOString(),
  };
}

// --- panel 3: funnel flow ----------------------------------------------------

async function fetchDeals(supabase: SupabaseClient): Promise<DealRow[]> {
  const { data, error } = await supabase
    .from("deals")
    .select(DEAL_COLUMNS)
    .eq("archived", 0)
    .limit(PAGE);
  if (error) throw error;
  return (data ?? []) as DealRow[];
}

async function fetchOutreach(
  supabase: SupabaseClient,
): Promise<{ events: OutreachEventRow[]; prospects: ProspectRow[] }> {
  // Only the funnel events matter; `added` (20k rows) is excluded.
  const { data: evRows, error: evErr } = await supabase
    .from("outreach_events")
    .select("prospect_id,event,occurred_at")
    .neq("event", "added")
    .limit(PAGE);
  if (evErr) throw evErr;
  const events = (evRows ?? []) as OutreachEventRow[];

  // Only prospects referenced by a funnel event need their engine/email.
  const ids = Array.from(
    new Set(events.map((e) => e.prospect_id).filter((v): v is number => v != null)),
  );
  const prospects: ProspectRow[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const { data, error } = await supabase
      .from("outreach_prospects")
      .select("id,email,engine,status")
      .in("id", chunk);
    if (error) throw error;
    prospects.push(...((data ?? []) as ProspectRow[]));
  }
  return { events, prospects };
}

async function fetchQuoteLatencyPairs(
  supabase: SupabaseClient,
  deals: DealRow[],
): Promise<QuoteLatencyPair[]> {
  // "Quote sent" proxy: the earliest DONE quote job per deal (the quote
  // artifact was produced right before the human send step). Labelled as a
  // proxy in the UI. quote_jobs.created_at/processed_at are ISO text.
  const { data, error } = await supabase
    .from("quote_jobs")
    .select("deal_id,processed_at")
    .eq("kind", "quote")
    .eq("status", "done")
    .not("processed_at", "is", null)
    .limit(PAGE);
  if (error) throw error;

  const earliestDone = new Map<number, number>();
  for (const row of (data ?? []) as { deal_id: number; processed_at: string }[]) {
    const t = parseTs(row.processed_at);
    if (Number.isNaN(t)) continue;
    const prev = earliestDone.get(row.deal_id);
    if (prev === undefined || t < prev) earliestDone.set(row.deal_id, t);
  }

  const createdById = new Map(deals.map((d) => [d.id, d.created_at]));
  const pairs: QuoteLatencyPair[] = [];
  for (const [dealId, doneMs] of earliestDone) {
    const created = createdById.get(dealId);
    if (!created) continue;
    pairs.push({ created_at: created, quote_sent_at: new Date(doneMs).toISOString() });
  }
  return pairs;
}

export async function fetchFunnelPayload(
  supabase: SupabaseClient,
  windowKey: WindowKey,
  now: Date,
): Promise<FunnelPayload> {
  const startMs = windowStart(windowKey, now).getTime();

  const deals = await fetchDeals(supabase);
  const { events, prospects } = await fetchOutreach(supabase);
  const latencyPairs = await fetchQuoteLatencyPairs(supabase, deals);

  return {
    window: windowKey,
    window_start: new Date(startMs).toISOString(),
    generated_at: now.toISOString(),
    outreach: computeOutreachFunnel(events, prospects, deals, startMs),
    deal_funnel: computeDealFunnel(deals, startMs),
    below_min: computeBelowMin(deals, startMs),
    quote_latency: computeQuoteLatency(latencyPairs, startMs),
  };
}

// --- panel 2: exception queue ------------------------------------------------

export type ExceptionItem = {
  kind: "draft_awaiting_send" | "reply_awaiting_handling";
  id: string; // stable dom key
  deal_id?: number;
  prospect_id?: number;
  title: string;
  subtitle: string | null;
  age_hours: number | null;
  gmail_thread_id?: string | null;
  email?: string | null;
};

export type ExceptionQueue = {
  drafts_awaiting_send: ExceptionItem[];
  replies_awaiting_handling: ExceptionItem[];
  generated_at: string;
  notes: string[];
};

function ageHours(iso: string | null | undefined, now: Date): number | null {
  const t = parseTs(iso ?? undefined);
  if (Number.isNaN(t)) return null;
  return Math.round(((now.getTime() - t) / 3_600_000) * 10) / 10;
}

export async function fetchExceptionQueue(
  supabase: SupabaseClient,
  now: Date,
): Promise<ExceptionQueue> {
  // Drafts awaiting send: deals parked at Quote Review — the machine produced a
  // quote/decline draft and is waiting on a human to actually send it. This is
  // an APPROXIMATION (Gmail drafts have no single DB source of truth); the UI
  // says so.
  const { data: draftDeals, error: dErr } = await supabase
    .from("deals")
    .select("id,company,contact_first_name,contact_last_name,contact_email,event_type,stage,updated_at,last_outbound_at,gmail_thread_id")
    .eq("archived", 0)
    .eq("stage", "Quote Review")
    .order("updated_at", { ascending: true })
    .limit(200);
  if (dErr) throw dErr;

  const drafts: ExceptionItem[] = (draftDeals ?? []).map((d: any) => ({
    kind: "draft_awaiting_send",
    id: `draft-${d.id}`,
    deal_id: d.id,
    title:
      [d.contact_first_name, d.contact_last_name].filter(Boolean).join(" ") ||
      d.company ||
      d.contact_email ||
      `Deal #${d.id}`,
    subtitle: [d.event_type, d.company].filter(Boolean).join(" · ") || null,
    age_hours: ageHours(d.updated_at, now),
    gmail_thread_id: d.gmail_thread_id,
    email: d.contact_email,
  }));

  // Replies awaiting handling: prospects with a recent replied/interested event
  // whose status is not already handed_off or suppressed (until the #285
  // reply->CRM bridge turns every reply into a deal, these need a human).
  const { data: replyRows, error: rErr } = await supabase
    .from("outreach_events")
    .select("prospect_id,event,occurred_at")
    .in("event", ["replied", "interested"])
    .order("occurred_at", { ascending: false })
    .limit(200);
  if (rErr) throw rErr;

  const latestReply = new Map<number, string>();
  for (const r of (replyRows ?? []) as OutreachEventRow[]) {
    if (r.prospect_id == null) continue;
    if (!latestReply.has(r.prospect_id)) latestReply.set(r.prospect_id, r.occurred_at);
  }

  let replies: ExceptionItem[] = [];
  const ids = Array.from(latestReply.keys());
  if (ids.length) {
    const { data: pRows, error: pErr } = await supabase
      .from("outreach_prospects")
      .select("id,name,company,email,status")
      .in("id", ids);
    if (pErr) throw pErr;
    replies = (pRows ?? [])
      .filter((p: any) => p.status !== "handed_off" && p.status !== "suppressed")
      .map((p: any) => ({
        kind: "reply_awaiting_handling" as const,
        id: `reply-${p.id}`,
        prospect_id: p.id,
        title: p.name || p.company || p.email || `Prospect #${p.id}`,
        subtitle: p.company || null,
        age_hours: ageHours(latestReply.get(p.id), now),
        email: p.email,
      }))
      .sort((a, b) => (b.age_hours ?? 0) - (a.age_hours ?? 0));
  }

  return {
    drafts_awaiting_send: drafts,
    replies_awaiting_handling: replies,
    generated_at: now.toISOString(),
    notes: [
      "Drafts = deals parked at Quote Review; a proxy for Gmail drafts, which have no single DB source of truth.",
      "Replies list clears automatically once the #285 reply→CRM bridge files each reply as a deal.",
      "Deferred exception types (no data source yet): boomerang drafts (public.deals has no boomerang_reason column — only the guardrail test schemas do), non-form candidates and manual-outbound-without-ref (both surfaced by the catering sweep, whose telemetry is not persisted — the proposed sweep_runs table lands them here).",
    ],
  };
}

export function resolveWindow(searchParam: string | null | undefined): WindowKey {
  return parseWindow(searchParam);
}
