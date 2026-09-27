// PROTOTYPE — Email campaigns tab. Read-only loader.
//
// Runs as the SIGNED-IN manager through the SSR client, like the call desk and
// the Funnels tab: outreach_* and deals are gated by the existing
// `(select is_manager())` RLS policies. No service-role client, no writes, no
// migrations. The warm/cold queue views are not granted to `authenticated`,
// so model.ts replicates their WHERE clauses over these raw rows.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealRow, MailboxRow, ProspectRow, RawData } from "./model";

const PAGE = 1000; // PostgREST max-rows

async function all<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  orderBy: string,
): Promise<T[]> {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  const n = count ?? 0;
  const pages = Math.ceil(n / PAGE);
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      supabase
        .from(table)
        .select(columns)
        .order(orderBy, { ascending: true })
        .range(i * PAGE, i * PAGE + PAGE - 1),
    ),
  );
  const rows: T[] = [];
  for (const r of results) {
    if (r.error) throw r.error;
    rows.push(...((r.data ?? []) as T[]));
  }
  return rows;
}

export async function loadRawData(supabase: SupabaseClient): Promise<RawData> {
  const [prospects, deals, suppression, blocked, mailboxes] = await Promise.all([
    all<ProspectRow>(
      supabase,
      "outreach_prospects",
      "id,name,company,email,status,engine,category,ever_booked,last_event_date,marketing_opt_in,last_outreach_at,verify_status",
      "id",
    ),
    all<DealRow>(
      supabase,
      "deals",
      "id,contact_email,event_type,stage,event_date,created_at,last_outbound_at,source",
      "id",
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
    suppressedEmails: suppression.map((s) => s.email).filter((e): e is string => !!e),
    blockedDomains: (blocked.data ?? []).map((b: { domain: string }) => b.domain),
    mailboxes: (mailboxes.data ?? []) as MailboxRow[],
  };
}
