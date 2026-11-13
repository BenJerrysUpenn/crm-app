// PROTOTYPE (bj-finance #811), throwaway. The console's extra reads, beside
// the Email campaigns tab's own loadRawData (load.ts, reused as is).
//
// Same rules as the tab: the SIGNED-IN manager's SSR client, the existing
// `(select is_manager())` RLS policies, no service-role client, no writes, no
// migrations. Only columns the screen needs: no reply snippets, no sender
// addresses, no contact emails are read here.

import type { SupabaseClient } from "@supabase/supabase-js";

export type MailboxFull = {
  address: string;
  daily_allowance: number;
  frozen: boolean;
  frozen_reason: string | null;
  frozen_at: string | null;
  unverified_ration: number | null;
  unverified_ration_at: string | null;
  allowance_ceiling: number | null;
  wedding_daily_allowance: number | null;
};

/** One 'sequenced' outreach_events row with the mailbox that sent it.
 * `apollo` marks a cold Apollo enrolment (not a send: Apollo-side sends are
 * not stored, so cold sends are No data). */
export type SendEvent = {
  id: number;
  prospect_id: number;
  at: string;
  mailbox: string | null;
  template: string | null;
  apollo: boolean;
};

/** Outcome and handling events. No detail beyond the mailbox. */
export type OutcomeEvent = {
  id: number;
  prospect_id: number;
  event: "replied" | "handed_off" | "lost" | "suppressed" | "deal_created" | "bounced" | "unsubscribed";
  at: string;
  mailbox: string | null;
};

export type ConsoleExtras = {
  mailboxes: MailboxFull[];
  sends: SendEvent[];
  outcomes: OutcomeEvent[];
};

const PAGE = 1000;

async function paged<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 50; i++) {
    const { data, error } = await build(i * PAGE, i * PAGE + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const OUTCOME_EVENTS = ["replied", "handed_off", "lost", "suppressed", "deal_created", "bounced", "unsubscribed"];

/** Reads the last `days` days of sends, every outcome event (a few hundred
 * rows, so step reply counts are all-time), and every mailbox. */
export async function loadConsoleExtras(supabase: SupabaseClient, now: Date, days = 35): Promise<ConsoleExtras> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const [mb, sends, outcomes] = await Promise.all([
    supabase
      .from("outreach_mailboxes")
      .select(
        "address,daily_allowance,frozen,frozen_reason,frozen_at,unverified_ration,unverified_ration_at,allowance_ceiling,wedding_daily_allowance",
      ),
    paged<{ id: number; prospect_id: number; at: string; mailbox: string | null; template: string | null; apollo: string | null }>(
      (from, to) =>
        supabase
          .from("outreach_events")
          .select("id,prospect_id,at:occurred_at,mailbox:detail->>mailbox,template:detail->>template,apollo:detail->>apollo_sequence_id")
          .eq("event", "sequenced")
          .gte("occurred_at", since)
          .order("id", { ascending: true })
          .range(from, to),
    ),
    paged<OutcomeEvent>((from, to) =>
      supabase
        .from("outreach_events")
        .select("id,prospect_id,event,at:occurred_at,mailbox:detail->>mailbox")
        .in("event", OUTCOME_EVENTS)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  if (mb.error) throw mb.error;
  return {
    mailboxes: (mb.data ?? []) as MailboxFull[],
    sends: sends.map((s) => ({ ...s, apollo: !!s.apollo })),
    outcomes,
  };
}
