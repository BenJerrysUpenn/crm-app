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
import { easternTodayYmd, easternWallTimeToUTCISO } from "@/lib/dateFormat";
import type { Stage } from "@/lib/stages";
import {
  buildExceptionQueue,
  computeBelowMin,
  computeDealFunnel,
  computeOutreachFunnel,
  computeQuoteLatency,
  pairQuoteLatency,
} from "./compute";
import { REPLY_EVENTS } from "./types";
import type {
  DealRow,
  DoneQuoteJobRow,
  DraftDealRow,
  ExceptionQueue,
  FunnelPayload,
  OutreachEventRow,
  ProspectRow,
  QuoteLatencyPair,
  ReplyProspectRow,
} from "./types";
import { windowStart, type WindowKey } from "./windows";

// Page size for range reads; deals and non-added events are both well under a
// couple thousand rows, so a single 5000-row page covers them.
const PAGE = 5000;

// The stage a deal parks at while its machine-produced draft waits on a human
// send. Typed against lib/stages.ts, so a renamed stage fails tsc.
const DRAFT_AWAITING_SEND_STAGE: Stage = "Quote Review";

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
  // Midnight of today's Eastern calendar date, resolved with the offset in
  // force AT THAT MIDNIGHT (not at `now`), so the "sends today" boundary is
  // right even on a DST-change day. The rule lives once in lib/dateFormat.ts;
  // the catering shift windows read the same function. A parse failure is not
  // reachable (easternTodayYmd always yields YYYY-MM-DD) but is guarded.
  const iso = easternWallTimeToUTCISO(easternTodayYmd(now), "00:00");
  if (!iso) throw new Error("easternDayStartISO: could not resolve today");
  return iso;
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
  // Throw on error like every other read here: on a supervision view a silent
  // `null` renders as "Last engine activity never", a false all-clear if the
  // read actually failed (RLS / missing table). Fail loudly so the GET surfaces
  // 503/500 and the UI shows the error state instead (CODING_STANDARDS.md:10).
  const { data: lastEvt, error: lastEvtError } = await supabase
    .from("outreach_events")
    .select("occurred_at")
    .neq("event", "added")
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (lastEvtError) throw lastEvtError;

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
  // quote_jobs.created_at/processed_at are ISO text.
  const { data, error } = await supabase
    .from("quote_jobs")
    .select("deal_id,processed_at")
    .eq("kind", "quote")
    .eq("status", "done")
    .not("processed_at", "is", null)
    .limit(PAGE);
  if (error) throw error;
  return pairQuoteLatency((data ?? []) as DoneQuoteJobRow[], deals);
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

export async function fetchExceptionQueue(
  supabase: SupabaseClient,
  now: Date,
): Promise<ExceptionQueue> {
  // Drafts awaiting send: deals parked at Quote Review — the machine produced a
  // quote/decline draft and is waiting on a human to actually send it.
  const { data: draftDeals, error: dErr } = await supabase
    .from("deals")
    .select("id,company,contact_first_name,contact_last_name,contact_email,event_type,stage,updated_at,last_outbound_at,gmail_thread_id")
    .eq("archived", 0)
    .eq("stage", DRAFT_AWAITING_SEND_STAGE)
    .order("updated_at", { ascending: true })
    .limit(200);
  if (dErr) throw dErr;

  // Replies awaiting handling: the newest replied/interested events, newest
  // first, then the prospects they name.
  const { data: replyRows, error: rErr } = await supabase
    .from("outreach_events")
    .select("prospect_id,event,occurred_at")
    .in("event", [...REPLY_EVENTS])
    .order("occurred_at", { ascending: false })
    .limit(200);
  if (rErr) throw rErr;
  const replyEvents = (replyRows ?? []) as OutreachEventRow[];

  const ids = Array.from(
    new Set(
      replyEvents.map((e) => e.prospect_id).filter((v): v is number => v != null),
    ),
  );
  let replyProspects: ReplyProspectRow[] = [];
  if (ids.length) {
    const { data: pRows, error: pErr } = await supabase
      .from("outreach_prospects")
      .select("id,name,company,email,status")
      .in("id", ids);
    if (pErr) throw pErr;
    replyProspects = (pRows ?? []) as ReplyProspectRow[];
  }

  return buildExceptionQueue(
    (draftDeals ?? []) as DraftDealRow[],
    replyEvents,
    replyProspects,
    now,
  );
}
