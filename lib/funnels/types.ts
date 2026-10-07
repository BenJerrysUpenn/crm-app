// Row and result shapes for the Funnels tab (bj-finance #422).
//
// The *Row types are the minimal projections the query layer pulls from
// Supabase; the pure compute layer (compute.ts) only ever sees these, never a
// live client, so it stays testable.

import type { Profile } from "./profile";
import type { WindowKey } from "./windows";

export const ENGINES = ["warm", "cold"] as const;
export type Engine = (typeof ENGINES)[number];

// The outreach events that count as a prospect replying. One list, so the
// funnel's "replied" step and the exception queue's "replies awaiting
// handling" agree on what a reply is.
export const REPLY_EVENTS = ["replied", "interested"] as const;

// --- Raw row projections -----------------------------------------------------

export type ProspectRow = {
  id: number;
  email: string | null;
  engine: Engine | null;
  status: string | null;
};

export type OutreachEventRow = {
  prospect_id: number | null;
  event: string;
  occurred_at: string; // ISO
};

export type DealRow = {
  id: number;
  stage: string;
  contact_email: string | null;
  event_type: string | null;
  created_at: string; // ISO text
  updated_at: string; // ISO text
  total_with_tax: number | null;
  subtotal_pretax: number | null;
  signed_contract_total: number | null;
};

/** A deal parked at Quote Review, as the exception queue reads it. */
export type DraftDealRow = {
  id: number;
  company: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_email: string | null;
  event_type: string | null;
  updated_at: string | null; // ISO text
  gmail_thread_id: string | null;
};

/** A prospect named by a reply event, as the exception queue reads it. */
export type ReplyProspectRow = {
  id: number;
  name: string | null;
  company: string | null;
  email: string | null;
  status: string | null;
};

/** A finished quote job: the deal it quoted and when it was produced (ISO text). */
export type DoneQuoteJobRow = {
  deal_id: number;
  processed_at: string;
};

/** A deal-created instant paired with when its quote was produced (proxy for sent). */
export type QuoteLatencyPair = {
  created_at: string; // ISO
  quote_sent_at: string; // ISO
};

// --- Computed results --------------------------------------------------------

export type OutreachFunnel = {
  engine: Engine;
  sent: number;
  replied: number;
  handed_off: number;
  deal: number;
  quoted: number;
  booked: number;
};

export type DealFunnelRow = {
  profile: Profile | "__all__";
  created: number;
  quoted: number;
  booked: number;
  complete: number;
  below_min: number;
  booked_value: number; // $ of booked + complete deals
  quoted_value: number; // $ of deals that reached quoted
};

export type BelowMinResult = {
  overall: { below_min: number; total: number; share: number };
  by_profile: { profile: Profile; below_min: number; total: number; share: number }[];
};

export type QuoteLatencyTrendPoint = {
  week_start: string; // ISO (Monday)
  median_hours: number | null;
  count: number;
};

export type QuoteLatencyResult = {
  median_hours: number | null;
  count: number;
  trend: QuoteLatencyTrendPoint[];
};

export type FunnelPayload = {
  window: WindowKey;
  window_start: string;
  generated_at: string;
  outreach: OutreachFunnel[];
  deal_funnel: DealFunnelRow[];
  below_min: BelowMinResult;
  quote_latency: QuoteLatencyResult;
};

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
