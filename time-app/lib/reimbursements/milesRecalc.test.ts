// When a deal with no round-trip miles gets a miles recalculation
// (./milesRecalc.ts; the owner, 2026-10-29): the dedupe per deal over its
// miles jobs (kind 'miles' or 'retriage'; server.ts reads both), at most one
// an hour, and whether the last one failed.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { RECALC_RETRY_MS, noMilesDeals, planRecalc, withRecalcState, type RecalcJob } from "./milesRecalc.ts";

const NOW = Date.parse("2026-10-29T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

function job(id: number, status: RecalcJob["status"], createdAgoMs: number): RecalcJob {
  return { id, deal_id: 501, status, created_at: ago(createdAgoMs) };
}

test("planRecalc: none yet queues the first", () => {
  assert.deepEqual(planRecalc([], NOW), { queue: true, why: "first", failed: false });
});

test("planRecalc: one pending or running, however old, queues none", () => {
  assert.deepEqual(planRecalc([job(1, "pending", 5 * 60 * MIN)], NOW), { queue: false, why: "in_flight", failed: false });
  assert.deepEqual(planRecalc([job(1, "running", 2 * MIN)], NOW), { queue: false, why: "in_flight", failed: false });
  // A failed one before it: the text says so while the new one runs.
  assert.deepEqual(planRecalc([job(1, "error", 90 * MIN), job(2, "pending", 1 * MIN)], NOW), { queue: false, why: "in_flight", failed: true });
});

test("planRecalc: at most one an hour, by the newest one's created_at", () => {
  assert.deepEqual(planRecalc([job(1, "error", 59 * MIN)], NOW), { queue: false, why: "recent", failed: true });
  assert.deepEqual(planRecalc([job(1, "error", RECALC_RETRY_MS)], NOW), { queue: true, why: "retry", failed: true });
  // Only the newest counts: an old one does not let a new one through early.
  assert.deepEqual(planRecalc([job(1, "error", 300 * MIN), job(2, "done", 10 * MIN)], NOW), { queue: false, why: "recent", failed: true });
  assert.deepEqual(planRecalc([job(2, "done", 10 * MIN), job(1, "error", 300 * MIN)], NOW).why, "recent", "any order");
});

test("planRecalc: a finished one, error or done, while the deal still has no miles is a failure", () => {
  assert.equal(planRecalc([job(1, "done", 2 * 60 * MIN)], NOW).failed, true);
  assert.equal(planRecalc([job(1, "error", 2 * 60 * MIN)], NOW).failed, true);
});

test("planRecalc: an unreadable created_at counts as just now, so nothing is queued on a guess", () => {
  assert.deepEqual(planRecalc([{ id: 1, deal_id: 501, status: "error", created_at: "" }], NOW), { queue: false, why: "recent", failed: true });
});

test("noMilesDeals: each deal once, only Catering Events capped for no round-trip miles", () => {
  const noMiles = { cap_cents_per_mile: 0, basis: "no_miles_on_deal" } as const;
  assert.deepEqual(
    noMilesDeals([
      { reason_kind: "catering_event", deal_id: 501, mileage_cap: noMiles },
      { reason_kind: "catering_event", deal_id: 501, mileage_cap: noMiles },
      { reason_kind: "catering_event", deal_id: 502, mileage_cap: { cap_cents_per_mile: 0, basis: "no_rate_on_quote" } },
      { reason_kind: "catering_event", deal_id: 503, mileage_cap: { cap_cents_per_mile: 72.5, basis: "quote_derived" } },
      { reason_kind: "catering_event", deal_id: 504, mileage_cap: null },
      { reason_kind: "errands", deal_id: null, mileage_cap: null },
      { reason_kind: "catering_event", deal_id: 505, mileage_cap: noMiles },
    ]),
    [501, 505],
  );
});

test("withRecalcState: marks the cap of each trip whose deal's Recalculate failed, and nothing else", () => {
  const noMiles = { cap_cents_per_mile: 0, basis: "no_miles_on_deal" } as const;
  const rows = [
    { id: 1, reason_kind: "catering_event", deal_id: 501, mileage_cap: noMiles },
    { id: 2, reason_kind: "catering_event", deal_id: 505, mileage_cap: noMiles },
    { id: 3, reason_kind: "catering_event", deal_id: 501, mileage_cap: { cap_cents_per_mile: 72.5, basis: "quote_derived" as const } },
  ];
  const out = withRecalcState(rows, new Set([501]));
  assert.deepEqual(out[0].mileage_cap, { ...noMiles, recalc_failed: true });
  assert.deepEqual(out[1].mileage_cap, noMiles);
  assert.deepEqual(out[2].mileage_cap, { cap_cents_per_mile: 72.5, basis: "quote_derived" });
  assert.equal(rows[0].mileage_cap, noMiles, "the input is not changed");
});
