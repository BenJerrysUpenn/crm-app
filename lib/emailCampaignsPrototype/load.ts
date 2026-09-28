// PROTOTYPE — Email campaigns tab. Read-only loader.
//
// Runs as the SIGNED-IN manager through the SSR client, like the call desk and
// the Funnels tab: outreach_* and deals are gated by the existing
// `(select is_manager())` RLS policies. No service-role client, no writes, no
// migrations. The warm/cold queue views are not granted to `authenticated`,
// so model.ts replicates their WHERE clauses over these raw rows.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealRow, MailboxRow, ProspectRow, RawData, SentRow } from "./model";

const PAGE = 1000; // PostgREST max-rows

async function all<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  orderBy: string,
  eq?: [string, string],
): Promise<T[]> {
  let head = supabase.from(table).select("*", { count: "exact", head: true });
  if (eq) head = head.eq(eq[0], eq[1]);
  const { count, error } = await head;
  if (error) throw error;
  const n = count ?? 0;
  const pages = Math.ceil(n / PAGE);
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      let q = supabase.from(table).select(columns);
      if (eq) q = q.eq(eq[0], eq[1]);
      return q.order(orderBy, { ascending: true }).range(i * PAGE, i * PAGE + PAGE - 1);
    }),
  );
  const rows: T[] = [];
  for (const r of results) {
    if (r.error) throw r.error;
    rows.push(...((r.data ?? []) as T[]));
  }
  return rows;
}

export async function loadRawData(supabase: SupabaseClient): Promise<RawData> {
  const [prospects, deals, sent, suppression, blocked, mailboxes] = await Promise.all([
    all<ProspectRow>(
      supabase,
      "outreach_prospects",
      "id,name,company,email,status,engine,category,ever_booked,last_event_date,marketing_opt_in,opt_in_source,last_outreach_at,verify_status",
      "id",
    ),
    all<DealRow>(
      supabase,
      "deals",
      "id,contact_email,event_type,stage,event_date,created_at,last_outbound_at,source",
      "id",
    ),
    // v5: the send history. One row per email sent; `template` says which.
    all<SentRow & { id: number }>(
      supabase,
      "outreach_events",
      "id,prospect_id,template:detail->>template",
      "id",
      ["event", "sequenced"],
    ),
    all<{ email: string | null }>(supabase, "outreach_suppression", "id,email", "id"),
    supabase.from("outreach_blocked_providers").select("domain"),
    supabase.from("outreach_mailboxes").select("address,daily_allowance,frozen"),
  ]);
  if (blocked.error) throw blocked.error;
  if (mailboxes.error) throw mailboxes.error;
  return {
    prospects,
    deals,
    sent: sent.map(({ prospect_id, template }) => ({ prospect_id, template })),
    suppressedEmails: suppression.map((s) => s.email).filter((e): e is string => !!e),
    blockedDomains: (blocked.data ?? []).map((b: { domain: string }) => b.domain),
    mailboxes: (mailboxes.data ?? []) as MailboxRow[],
  };
}
