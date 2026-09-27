// Duplicate lookup for manual deal intake.
//
// Thin wrapper over the `deal_dedupe_candidates` RPC (supabase/crm/006). The
// matching itself is in SQL because the phone key has to be normalised on the
// column side, which PostgREST filters cannot do — see the migration.
//
// The result is a WARNING. Never a block: the same office books us four times
// a year from the same address and the fourth booking is a new deal, not a
// mistake. The caller decides.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  emailKey,
  phoneKey,
  type DedupeMatch,
  type DedupeResponse,
} from "@/lib/dealIntake";

type RpcRow = {
  kind: "deal" | "prospect";
  id: number;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  stage: string | null;
  event_date: string | null;
  matched_email: boolean;
  matched_phone: boolean;
};

// PostgREST/Postgres "function does not exist".
const UNDEFINED_FUNCTION = "42883";
export const DEDUPE_MIGRATION_MISSING =
  "Duplicate checking is unavailable until supabase/crm/006_manual_deal_intake.sql " +
  "is applied. Creating deals still works.";

/** Shape one RPC row into the client's view of a match. */
export function toMatch(row: RpcRow): DedupeMatch {
  const matched: DedupeMatch["matched"] = [];
  if (row.matched_email) matched.push("email");
  if (row.matched_phone) matched.push("phone");
  return {
    kind: row.kind,
    id: row.id,
    name: row.name,
    company: row.company,
    email: row.email,
    phone: row.phone,
    ...(row.kind === "deal"
      ? { stage: row.stage, event_date: row.event_date }
      : {}),
    matched,
  };
}

export type FindDuplicatesResult = DedupeResponse & {
  /** Set when the lookup could not run at all. Intake carries on regardless:
   *  a missing duplicate check must never stop somebody writing down a
   *  customer who is standing at the counter. */
  unavailable?: string;
};

export async function findDuplicates(
  supabase: SupabaseClient,
  input: { email?: string | null; phone?: string | null; limit?: number },
): Promise<FindDuplicatesResult> {
  const email = emailKey(input.email);
  const phone = phoneKey(input.phone);
  if (!email && !phone) return { matches: [], skipped: true };

  const { data, error } = await supabase.rpc("deal_dedupe_candidates", {
    p_email: email,
    p_phone: phone,
    p_limit: input.limit ?? 10,
  });

  if (error) {
    const missing =
      error.code === UNDEFINED_FUNCTION ||
      /deal_dedupe_candidates/.test(error.message ?? "");
    return {
      matches: [],
      skipped: false,
      unavailable: missing ? DEDUPE_MIGRATION_MISSING : error.message,
    };
  }

  return {
    matches: ((data ?? []) as RpcRow[]).map(toMatch),
    skipped: false,
  };
}

type DealDetailRow = {
  id: number;
  contact_first_name: string | null;
  contact_last_name: string | null;
  venue_name: string | null;
  venue_address: string | null;
  updated_at: string | null;
  created_at: string | null;
};

/** The deal columns autofill needs that the RPC does not return. */
export const DEAL_DETAIL_COLUMNS =
  "id, contact_first_name, contact_last_name, venue_name, venue_address, updated_at, created_at";

/** Attach what the New deal form can autofill from to each matched deal:
 *  first and last name separately, venue name and address, and how recent
 *  the row is.
 *
 *  A second read by id rather than a wider RPC, so no migration is needed.
 *  It runs as the signed-in user, so the manager RLS policy on `deals` guards
 *  it exactly as it guards the RPC (SECURITY INVOKER): nobody sees a column
 *  here they could not already read. Best effort — if the read fails the
 *  matches go back as they came, and autofill falls back to the joined name. */
export async function attachDealDetails(
  supabase: SupabaseClient,
  matches: DedupeMatch[],
): Promise<DedupeMatch[]> {
  const ids = matches.filter((m) => m.kind === "deal").map((m) => m.id);
  if (ids.length === 0) return matches;

  const { data, error } = await supabase
    .from("deals")
    .select(DEAL_DETAIL_COLUMNS)
    .in("id", ids);
  if (error || !data) return matches;

  const byId = new Map(
    (data as unknown as DealDetailRow[]).map((row) => [Number(row.id), row]),
  );
  return matches.map((m) => {
    const row = m.kind === "deal" ? byId.get(m.id) : undefined;
    if (!row) return m;
    return {
      ...m,
      first_name: row.contact_first_name,
      last_name: row.contact_last_name,
      venue_name: row.venue_name,
      venue_address: row.venue_address,
      touched_at: row.updated_at ?? row.created_at,
    };
  });
}
