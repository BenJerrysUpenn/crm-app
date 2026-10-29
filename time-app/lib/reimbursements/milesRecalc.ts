// The miles recalculation for a Catering Event whose quote charged mileage but
// whose deal has no round-trip miles (cap basis 'no_miles_on_deal', migration
// 50). The owner, 2026-10-29: "if there's a charge there should be miles. If
// you get into that case, just recalculate miles." And: the automatic
// recalculation changes ONLY the miles; nothing else on the deal may change.
//
// So the time app does not queue the CRM's Recalculate (kind 'retriage'),
// which also rewrites drive time, staff count, labor hours and the times. It
// inserts one quote_jobs row { deal_id, status 'pending', kind 'miles',
// requested_by }, with the service role (staff cannot read deals or
// quote_jobs), when a trip is submitted and when the Approver's queue loads
// (lib/reimbursements/server.ts, recalculateMissingMiles). Catering-Manager's
// quote worker claims it and writes deals.round_trip_miles from the venue
// address (the same two legs Recalculate uses) and nothing else
// (quote_worker._process_miles_job; Catering-Manager migration 027 admits the
// kind). Once the miles land, the trip reprices on its next read; until then
// the Approver cannot approve it (noMilesRefusal in ./money.ts).
//
// Dedupe, per deal, over both kinds ('miles' and 'retriage', whoever queued
// it), because a manager's Recalculate fills the miles too: none while one is
// pending or running, and none within RECALC_RETRY_MS of the newest one's
// created_at. So a deal gets at most one miles recalculation an hour.
//
// Pure, so `node --test` runs it.

import type { MileageCap } from "./money.ts";

/** quote_jobs.kind the time app queues: round-trip miles only. */
export const RECALC_KIND = "miles";

/** The quote_jobs kinds that fill round-trip miles, so the dedupe counts them all: the time app's and the CRM's Recalculate button's. */
export const MILES_JOB_KINDS = [RECALC_KIND, "retriage"] as const;

/** quote_jobs.requested_by on the rows the time app queues; the worker attributes its deal writes to it. */
export const RECALC_REQUESTED_BY = "withers-time:no-miles-on-deal";

/** The least time between two miles recalculations of one deal: one hour. */
export const RECALC_RETRY_MS = 60 * 60 * 1000;

/** A quote_jobs row of a MILES_JOB_KINDS kind, as far as the dedupe reads it. */
export type RecalcJob = {
  id: number;
  deal_id: number;
  status: "pending" | "running" | "done" | "error";
  /** ISO text (quote_jobs.created_at is TEXT). */
  created_at: string;
};

/**
 * What to do for one deal that still has no round-trip miles:
 *   queue   true when a miles recalculation should be queued now;
 *   why     in_flight (one is pending or running), recent (the newest was
 *           queued under RECALC_RETRY_MS ago), first (none yet), or retry
 *           (the newest is older than that and finished);
 *   failed  a miles job already finished and the deal still has no miles
 *           (it errored, e.g. no venue address, or found none): a manager
 *           should check the venue address.
 */
export type RecalcPlan = { queue: boolean; why: "in_flight" | "recent" | "first" | "retry"; failed: boolean };

function inFlight(j: RecalcJob): boolean {
  return j.status === "pending" || j.status === "running";
}

/** The plan for one deal from its miles jobs, of either kind (any order), at `now` (ms). */
export function planRecalc(jobs: RecalcJob[], now: number): RecalcPlan {
  const newest = [...jobs].sort((a, b) => Number(b.id) - Number(a.id));
  const failed = newest.some((j) => !inFlight(j));
  if (newest.some(inFlight)) return { queue: false, why: "in_flight", failed };
  const latest = newest[0];
  if (!latest) return { queue: true, why: "first", failed };
  const at = Date.parse(latest.created_at);
  // An unreadable time counts as just now: never queue on a guess.
  if (!Number.isFinite(at) || now - at < RECALC_RETRY_MS) return { queue: false, why: "recent", failed };
  return { queue: true, why: "retry", failed };
}

type Capped = { reason_kind: string; deal_id: number | null; mileage_cap: MileageCap | null };

/** The deals, each once, whose trips here cap at 0c because the deal has no round-trip miles. */
export function noMilesDeals(rows: Capped[]): number[] {
  const ids = rows
    .filter((r) => r.reason_kind === "catering_event" && r.deal_id != null && r.mileage_cap?.basis === "no_miles_on_deal")
    .map((r) => r.deal_id as number);
  return Array.from(new Set(ids));
}

/** Rows with `recalc_failed` on the cap of each trip whose deal has a finished miles job and still no miles. */
export function withRecalcState<T extends Capped>(rows: T[], failed: ReadonlySet<number>): T[] {
  return rows.map((r) =>
    r.mileage_cap?.basis === "no_miles_on_deal" && r.deal_id != null && failed.has(r.deal_id)
      ? { ...r, mileage_cap: { ...r.mileage_cap, recalc_failed: true } }
      : r,
  );
}
