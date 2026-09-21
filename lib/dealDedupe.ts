// Duplicate lookup for manual deal intake.
//
// Thin wrapper over the `deal_dedupe_candidates` RPC (supabase/crm/005). The
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
  "Duplicate checking is unavailable until supabase/crm/005_manual_deal_intake.sql " +
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
