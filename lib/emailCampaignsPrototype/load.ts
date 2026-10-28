// Email campaigns tab: read-only loader.
//
// Runs as the SIGNED-IN manager through the SSR client, like the call desk and
// the Funnels tab: outreach_* and deals are gated by the existing
// `(select is_manager())` RLS policies. No service-role client, no writes, no
// migrations. The warm/cold queue views are not granted to `authenticated`,
// so model.ts replicates their WHERE clauses over these raw rows.

import type { SupabaseClient } from "@supabase/supabase-js";
import { leadStatusOf, type DealRow, type HitRow, type MailboxRow, type ProspectRow, type RawData, type SentRow } from "./model";

const PAGE = 1000; // PostgREST max-rows

async function all<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  orderBy: string,
  eq?: [string, string],
  like?: [string, string],
): Promise<T[]> {
  let head = supabase.from(table).select("*", { count: "exact", head: true });
  if (eq) head = head.eq(eq[0], eq[1]);
  if (like) head = head.like(like[0], like[1]);
  const { count, error } = await head;
  if (error) throw error;
  const n = count ?? 0;
  const pages = Math.ceil(n / PAGE);
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      let q = supabase.from(table).select(columns);
      if (eq) q = q.eq(eq[0], eq[1]);
      if (like) q = q.like(like[0], like[1]);
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
  const [prospects, cakeNotes, deals, sent, opened, clicked, suppression, blocked, mailboxes] = await Promise.all([
    all<ProspectRow>(
      supabase,
      "outreach_prospects",
      "id,name,company,email,status,engine,category,ever_booked,last_event_date,marketing_opt_in,opt_in_source,last_outreach_at,verify_status,event_date,archived_at",
      "id",
    ),
    // Cake only (#286): Salesforce lead status Cake Order. Only rows whose
    // notes could start with it are read; leadStatusOf decides exactly.
    all<{ id: number; notes: string | null }>(
      supabase,
      "outreach_prospects",
      "id,notes",
      "id",
      undefined,
      ["notes", "Cake Order%"],
    ),
    all<DealRow>(
      supabase,
      "deals",
      "id,contact_email,event_type,stage,event_date,created_at,last_outbound_at,source",
      "id",
    ),
    // v5: the send history. One row per email sent; `template` says which,
    // and a tracked send's `tracking_id` ties its opens and clicks to it.
    all<SentRow & { id: number }>(
      supabase,
      "outreach_events",
      "id,prospect_id,sent_at:occurred_at,template:detail->>template,tracking_id:detail->>tracking_id",
      "id",
      ["event", "sequenced"],
    ),
    // Opens and clicks (docs/tracking.md): one row per pixel fetch / click.
    all<Omit<HitRow, "event"> & { id: number }>(
      supabase,
      "outreach_events",
      "id,prospect_id,tracking_id:detail->>tracking_id",
      "id",
      ["event", "opened"],
    ),
    all<Omit<HitRow, "event"> & { id: number }>(
      supabase,
      "outreach_events",
      "id,prospect_id,tracking_id:detail->>tracking_id",
      "id",
      ["event", "clicked"],
    ),
    all<{ email: string | null }>(supabase, "outreach_suppression", "id,email", "id"),
    supabase.from("outreach_blocked_providers").select("domain"),
    supabase.from("outreach_mailboxes").select("address,daily_allowance,frozen"),
  ]);
  if (blocked.error) throw blocked.error;
  if (mailboxes.error) throw mailboxes.error;
  const cakeLead = new Set(cakeNotes.filter((r) => leadStatusOf(r.notes) === "Cake Order").map((r) => r.id));
  return {
    prospects: prospects.map((p) => ({ ...p, cake_lead_status: cakeLead.has(p.id) })),
    deals,
    sent: sent.map(({ prospect_id, template, tracking_id, sent_at }) => ({ prospect_id, template, tracking_id, sent_at })),
    hits: [
      ...opened.map(({ prospect_id, tracking_id }) => ({ prospect_id, tracking_id, event: "opened" as const })),
      ...clicked.map(({ prospect_id, tracking_id }) => ({ prospect_id, tracking_id, event: "clicked" as const })),
    ],
    suppressedEmails: suppression.map((s) => s.email).filter((e): e is string => !!e),
    blockedDomains: (blocked.data ?? []).map((b: { domain: string }) => b.domain),
    mailboxes: (mailboxes.data ?? []) as MailboxRow[],
  };
}
