// Row and result shapes for the Funnels tab (bj-finance #422).
//
// The *Row types are the minimal projections the query layer pulls from
// Supabase; the pure compute layer (compute.ts) only ever sees these, never a
// live client, so it stays testable.

import type { Profile } from "./profile";
import type { WindowKey } from "./windows";

export type Engine = "warm" | "cold";

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
