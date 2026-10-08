// What the two Reimbursements pages read (bj-finance #210). Server-only: each
// takes the request's Supabase client, so every read runs under the viewer's
// own RLS (staff their own rows; Approvers everything). Read-only. Before
// migration 37 a missing table answers { ok: false } and the page says so.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingTable } from "@/lib/storeHours";
import type { MileageRate } from "./money";
import { alsoOnSameEvent } from "./events";
import { isOwner, mayDecide, type Person } from "./lifecycle";
import { NEEDS_MIGRATION, loadRates, withAmounts, type AdjustmentRow, type LyftRow, type ReimbursementRow, type WithAmounts } from "./server";

type Failed = { ok: false; error: string };

function failed(error: { message: string } | null): Failed | null {
  if (!error) return null;
  return { ok: false, error: isMissingTable(error) ? NEEDS_MIGRATION : error.message };
}

/** The staff page: the viewer's own reimbursements, newest trip first, and their Lyft ride reports. */
export async function loadMine(
  db: SupabaseClient,
  profileId: string,
): Promise<{ ok: true; reimbursements: WithAmounts[]; lyft: LyftRow[]; rates: MileageRate[] } | Failed> {
  const rates = await loadRates(db);
  if (!rates.ok) return rates;
  const [mine, lyft] = await Promise.all([
    db.from("travel_reimbursements").select("*").eq("profile_id", profileId).order("trip_date", { ascending: false }).order("id", { ascending: false }),
    db.from("lyft_ride_reports").select("*").eq("profile_id", profileId).order("trip_date", { ascending: false }).order("id", { ascending: false }),
  ]);
  const bad = failed(mine.error) ?? failed(lyft.error);
  if (bad) return bad;
  const rows = (mine.data ?? []) as ReimbursementRow[];
  const adj = rows.length
    ? await db.from("travel_reimbursement_adjustments").select("*").in("reimbursement_id", rows.map((r) => r.id))
    : { data: [], error: null };
  const badAdj = failed(adj.error);
  if (badAdj) return badAdj;
  return { ok: true, reimbursements: withAmounts(rows, rates.rates, (adj.data ?? []) as AdjustmentRow[]), lyft: (lyft.data ?? []) as LyftRow[], rates: rates.rates };
}

export type QueueItem = WithAmounts & {
  full_name: string | null;
  owner: boolean;
  /** Other live reimbursements on the same Catering Event (ruling 24). */
  also: { full_name: string | null; miles: number }[];
  /** Why the viewer may not decide it, or null when they may. */
  refused: string | null;
};

/**
 * The Reimbursements tab: every Submitted one (the queue) and every Approved
 * one not yet Paid (to send back, or for an owner's, to mark Paid outside
 * payroll), oldest trip first.
 */
export async function loadQueue(
  db: SupabaseClient,
  viewer: Person,
): Promise<{ ok: true; submitted: QueueItem[]; approved: QueueItem[] } | Failed> {
  const rates = await loadRates(db);
  if (!rates.ok) return rates;
  const open = await db
    .from("travel_reimbursements")
    .select("*")
    .in("status", ["submitted", "approved"])
    .order("trip_date", { ascending: true })
    .order("id", { ascending: true });
  const bad = failed(open.error);
  if (bad) return bad;
  const rows = (open.data ?? []) as ReimbursementRow[];
  const dealIds = Array.from(new Set(rows.map((r) => r.deal_id).filter((d): d is number => d != null)));
  const profileIds = Array.from(new Set(rows.map((r) => r.profile_id)));
  const [sameEvent, adj] = await Promise.all([
    dealIds.length
      ? db.from("travel_reimbursements").select("id, deal_id, status, profile_id, miles").in("deal_id", dealIds)
      : Promise.resolve({ data: [], error: null }),
    rows.length
      ? db.from("travel_reimbursement_adjustments").select("*").in("reimbursement_id", rows.map((r) => r.id))
      : Promise.resolve({ data: [], error: null }),
  ]);
  const bad2 = failed(sameEvent.error) ?? failed(adj.error);
  if (bad2) return bad2;
  const related = (sameEvent.data ?? []) as Pick<ReimbursementRow, "id" | "deal_id" | "status" | "profile_id" | "miles">[];
  for (const r of related) if (!profileIds.includes(r.profile_id)) profileIds.push(r.profile_id);
  const people = profileIds.length
    ? await db.from("profiles").select("id, role, active, full_name").in("id", profileIds)
    : { data: [], error: null };
  const byId = new Map(((people.data ?? []) as (Person & { full_name: string | null })[]).map((p) => [p.id, p]));
  const also = alsoOnSameEvent(related.map((r) => ({ ...r, full_name: byId.get(r.profile_id)?.full_name ?? null })));

  const items: QueueItem[] = withAmounts(rows, rates.rates, (adj.data ?? []) as AdjustmentRow[]).map((r) => {
    const subject = byId.get(r.profile_id) ?? { id: r.profile_id, role: "employee", active: true, full_name: null };
    return { ...r, full_name: subject.full_name, owner: isOwner(subject), also: also.get(r.id) ?? [], refused: mayDecide(viewer, subject) };
  });
  return { ok: true, submitted: items.filter((i) => i.status === "submitted"), approved: items.filter((i) => i.status === "approved") };
}
