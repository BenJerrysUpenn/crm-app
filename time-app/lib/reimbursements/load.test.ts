// What the Reimbursements pages read (lib/reimbursements/load.ts), against the
// stand-in Supabase: staff see only their own; the Approver's queue names
// everyone, flags owners, prices each item at its trip date's rate, says who
// may not be decided by this viewer, and surfaces a second person on the same
// Catering Event (bj-finance #210, ruling 24).
//
//   npm test

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "../testing/fakeSupabase.ts";

const { loadMine, loadQueue } = await loadAppModule<typeof import("./load.ts")>("lib/reimbursements/load.ts");
const { createClient } = await loadAppModule<typeof import("../supabase/server.ts")>("lib/supabase/server.ts");

const OWNER = { id: "00000000-0000-0000-0000-0000000000a1", role: "manager", active: false, full_name: "Alina Owner" };
const MANAGER = { id: "00000000-0000-0000-0000-0000000000a2", role: "manager", active: true, full_name: "Sophia Manager" };
const MANAGER2 = { id: "00000000-0000-0000-0000-0000000000a3", role: "manager", active: true, full_name: "Mira Manager" };
const DONTE = { id: "00000000-0000-0000-0000-0000000000b1", role: "employee", active: true, full_name: "Donte Driver" };
const SAM = { id: "00000000-0000-0000-0000-0000000000b2", role: "employee", active: true, full_name: "Sam Lee" };

function row(id: number, profile_id: string, over: Record<string, unknown> = {}) {
  return {
    id, profile_id, reason_kind: "catering_event", deal_id: 501, event_label: "Acme", trip_date: "2026-10-03",
    mileage_mode: "typed", miles: 10, tolls_cents: 0, parking_cents: 0, mileage_cents_override: null, receipt_paths: [],
    status: "submitted", ...over,
  };
}

let db: FakeSupabase;
beforeEach(() => {
  db = startFakeSupabase({
    profiles: [OWNER, MANAGER, MANAGER2, DONTE, SAM],
    mileage_rates: [{ starts_on: "2026-01-01", cents_per_mile: 72.5 }, { starts_on: "2026-07-01", cents_per_mile: 76 }],
    travel_reimbursements: [
      row(1, DONTE.id),
      row(2, SAM.id, { miles: 12.1, status: "approved" }),
      row(3, MANAGER.id, { deal_id: null, reason_kind: "errands", trip_date: "2026-06-30" }),
      row(4, OWNER.id, { deal_id: 777, status: "approved" }),
      row(5, SAM.id, { status: "paid", paid_on: "2026-10-09", updated_at: "2026-10-09T20:00:00Z" }),
      row(6, SAM.id, { deal_id: 900, status: "rejected", rejection_reason: "Which store?", decided_by: MANAGER.id, decided_at: "2026-10-09T01:30:00Z", updated_at: "2026-10-09T01:30:00Z" }),
      row(7, OWNER.id, { deal_id: 901, status: "paid_outside_payroll", paid_by: OWNER.id, paid_on: "2026-10-10", updated_at: "2026-10-10T15:00:00Z" }),
    ],
    travel_reimbursement_adjustments: [
      { id: 1, reimbursement_id: 1, field: "tolls", old_cents: 450, new_cents: 400, note: "x", evidence_path: "adjustments/1/a.png", adjusted_by: OWNER.id, adjusted_at: "2026-10-05T00:00:00Z" },
    ],
    lyft_ride_reports: [
      { id: 1, profile_id: DONTE.id, reason_kind: "errands", reason_note: "Depot", trip_date: "2026-10-01", screenshot_paths: ["x"] },
      { id: 2, profile_id: SAM.id, reason_kind: "errands", reason_note: "Depot", trip_date: "2026-10-01", screenshot_paths: ["y"] },
    ],
  });
});

test("loadMine: staff see their own reimbursements with amounts and Adjustments, and their own Lyft ride reports", async () => {
  db.signIn(DONTE.id);
  const mine = await loadMine(createClient(), DONTE.id);
  assert.ok(mine.ok);
  assert.deepEqual(mine.reimbursements.map((r) => r.id), [1]);
  assert.equal(mine.reimbursements[0].amounts.total_cents, 760);
  assert.equal(mine.reimbursements[0].adjustments.length, 1);
  assert.deepEqual(mine.lyft.map((l) => l.id), [1]);
});

test("loadQueue: Submitted and Approved-not-Paid, named, owners flagged, priced at the trip date's rate", async () => {
  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  assert.deepEqual(q.submitted.map((i) => i.id), [3, 1]);
  assert.deepEqual(q.approved.map((i) => i.id), [2, 4]);
  assert.equal(q.approved[1].owner, true);
  assert.equal(q.approved[1].full_name, "Alina Owner");
  assert.equal(q.submitted[0].amounts.total_cents, 725, "10 mi on 2026-06-30 at 72.5c");
  assert.equal(q.submitted[1].amounts.total_cents, 760, "10 mi on 2026-10-03 at 76c");
});

test("loadQueue: a second person on the same Catering Event is surfaced beside each, Paid ones included", async () => {
  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  const donte = q.submitted.find((i) => i.id === 1)!;
  assert.deepEqual(donte.also, [{ full_name: "Sam Lee", miles: 12.1 }, { full_name: "Sam Lee", miles: 10 }]);
  assert.deepEqual(q.approved.find((i) => i.id === 4)!.also, []);
});

test("loadQueue: says which this viewer may not decide: a non-owner manager's own", async () => {
  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  assert.match(q.submitted.find((i) => i.id === 3)!.refused ?? "", /owner decides it/);
  assert.equal(q.submitted.find((i) => i.id === 1)!.refused, null);
});

test("loadQueue: another manager may not decide a non-owner manager's; an owner may (ruling 28)", async () => {
  db.signIn(MANAGER2.id);
  const q = await loadQueue(createClient(), MANAGER2);
  assert.ok(q.ok);
  assert.match(q.submitted.find((i) => i.id === 3)!.refused ?? "", /not another manager/);
  assert.equal(q.submitted.find((i) => i.id === 1)!.refused, null);

  db.signIn(OWNER.id);
  const o = await loadQueue(createClient(), OWNER);
  assert.ok(o.ok);
  assert.equal(o.submitted.find((i) => i.id === 3)!.refused, null);
});

test("loadQueue: what has left the queue is listed under Decided, newest first, with who decided and when (ruling 41)", async () => {
  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  assert.deepEqual(q.decided.map((i) => i.id), [7, 5, 6]);
  const [owner, paid, rejected] = q.decided;
  assert.deepEqual([owner.status, owner.full_name, owner.decided_by_name, owner.decided_on], ["paid_outside_payroll", "Alina Owner", "Alina Owner", "2026-10-10"]);
  assert.deepEqual([paid.status, paid.decided_by_name, paid.decided_on], ["paid", null, "2026-10-09"]);
  assert.deepEqual(
    [rejected.status, rejected.full_name, rejected.decided_by_name, rejected.decided_on, rejected.rejection_reason],
    ["rejected", "Sam Lee", "Sophia Manager", "2026-10-08", "Which store?"],
    "rejected at 01:30 UTC on Oct 9 is 9:30 PM on Oct 8 in New York",
  );
  assert.equal(rejected.amounts.total_cents, 760);
  assert.ok(!q.submitted.some((i) => i.id === 6) && !q.approved.some((i) => i.id === 7));
});

test("loadQueue: when the people cannot be read it fails, rather than treating everyone as an employee", async () => {
  db.signIn(MANAGER.id);
  db.missingTables = ["profiles"];
  const q = await loadQueue(createClient(), MANAGER);
  assert.equal(q.ok, false);
});

test("loadQueue: Decided lists only the latest 50 that have left the queue", async () => {
  const many = Array.from({ length: 51 }, (_, i) =>
    row(100 + i, SAM.id, { status: "rejected", rejection_reason: "No receipt", decided_by: MANAGER.id, decided_at: "2026-09-01T12:00:00Z", updated_at: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T12:${String(i).padStart(2, "0")}:00Z` }),
  );
  db.tables.travel_reimbursements = many;
  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  assert.equal(q.decided.length, 50);
  // Row 100 (updated Sep 1, 12:00) is the oldest of the 51, so it is the one left out.
  assert.ok(!q.decided.some((i) => i.id === 100));
  assert.equal(q.decided[0].id, 127, "Sep 28 is the newest");
});

// ---------- a Catering Event pays no more a mile than its quote charged (migration 49) ----------

/** event_mileage_caps() as migration 49 answers it, for these deals. */
function caps(byDeal: Record<number, [number | null, string]>) {
  db.rpc.event_mileage_caps = (args) =>
    ((args.p_deal_ids as number[]) ?? [])
      .filter((id) => id in byDeal)
      .map((id) => ({ deal_id: id, cap_cents_per_mile: byDeal[id][0], basis: byDeal[id][1] }));
}

test("loadMine and loadQueue: a Catering Event trip is paid the lower of the IRS rate and what its quote charged", async () => {
  caps({ 501: [72.5, "quote_derived"], 777: [null, "uber_flat_fee"] });
  db.signIn(DONTE.id);
  const mine = await loadMine(createClient(), DONTE.id);
  assert.ok(mine.ok);
  assert.equal(mine.reimbursements[0].amounts.total_cents, 725, "10 mi on 2026-10-03 at the quote's 72.5c, not the IRS 76c");
  assert.equal(mine.reimbursements[0].amounts.capped, true);
  assert.deepEqual(mine.reimbursements[0].mileage_cap, { cap_cents_per_mile: 72.5, basis: "quote_derived" });

  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  const byId = new Map([...q.submitted, ...q.approved].map((i) => [i.id, i]));
  assert.equal(byId.get(2)!.amounts.total_cents, 877, "12.1 mi at 72.5c = 877.25 -> 877");
  assert.equal(byId.get(4)!.amounts.total_cents, 760, "the Uber flat fee event: the IRS rate");
  assert.equal(byId.get(4)!.amounts.capped, false);
  assert.equal(byId.get(3)!.amounts.total_cents, 725, "errands: the IRS rate on 2026-06-30");
  assert.equal(byId.get(3)!.mileage_cap, null);
});

test("loadMine: a Catering Event with no quote, or a quote that charged no mileage, is at the IRS rate (the owner, 2026-10-29)", async () => {
  for (const basis of ["no_quote", "no_rate_on_quote"]) {
    caps({ 501: [null, basis] });
    db.signIn(DONTE.id);
    const mine = await loadMine(createClient(), DONTE.id);
    assert.ok(mine.ok);
    assert.equal(mine.reimbursements[0].amounts.total_cents, 760, `${basis}: 10 mi at the IRS 76c`);
    assert.equal(mine.reimbursements[0].amounts.capped, false);
    assert.deepEqual(mine.reimbursements[0].mileage_cap, { cap_cents_per_mile: null, basis });
  }
});

test("loadQueue: a Decided Catering Event is shown at its cap too", async () => {
  caps({ 900: [72.5, "quoted_rate"] });
  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  const rejected = q.decided.find((i) => i.id === 6)!;
  assert.equal(rejected.amounts.total_cents, 725, "10 mi at the quote's 72.5c, not the IRS 76c");
  assert.equal(rejected.amounts.capped, true);
});

test("loadMine: a cap Postgres answers as a numeric string still caps the trip", async () => {
  db.rpc.event_mileage_caps = () => [{ deal_id: "501", cap_cents_per_mile: "72.50", basis: "quoted_rate" }];
  db.signIn(DONTE.id);
  const mine = await loadMine(createClient(), DONTE.id);
  assert.ok(mine.ok);
  assert.equal(mine.reimbursements[0].amounts.total_cents, 725);
  assert.deepEqual(mine.reimbursements[0].mileage_cap, { cap_cents_per_mile: 72.5, basis: "quoted_rate" });
});

test("loadMine: before migration 49 (no event_mileage_caps) every trip is at the IRS rate, as before", async () => {
  db.signIn(DONTE.id);
  const mine = await loadMine(createClient(), DONTE.id);
  assert.ok(mine.ok);
  assert.equal(mine.reimbursements[0].amounts.total_cents, 760);
  assert.equal(mine.reimbursements[0].mileage_cap, null);
});

test("loadMine and loadQueue: when the caps cannot be read they fail, rather than pay the uncapped rate", async () => {
  db.rpc.event_mileage_caps = () => {
    throw new Error("connection reset");
  };
  db.signIn(DONTE.id);
  assert.equal((await loadMine(createClient(), DONTE.id)).ok, false);
  db.signIn(MANAGER.id);
  assert.equal((await loadQueue(createClient(), MANAGER)).ok, false);
});

// ---------- a deal with no round-trip miles gets a miles recalculation (the owner, 2026-10-29) ----------

const MINUTE = 60_000;
const minutesAgo = (m: number) => new Date(Date.now() - m * MINUTE).toISOString();
/** A quote_jobs row as the CRM's Recalculate button (kind 'retriage', the default) or the time app (kind 'miles') leaves it, after the worker. */
function recalcJob(id: number, deal_id: number, status: string, createdMinutesAgo: number, kind = "retriage") {
  return { id, deal_id, status, kind, created_at: minutesAgo(createdMinutesAgo), requested_by: "someone@example.test" };
}
const queued = () => db.rows("quote_jobs").filter((j) => j.requested_by === "withers-time:no-miles-on-deal");

test("loadQueue: each deal with no round-trip miles that an unpaid trip waits on gets one miles-only recalculation (kind 'miles'); loading again queues none", async () => {
  // 501: rows 1 (Submitted) and 2 (Approved); 900: row 6, Rejected, off the queue.
  caps({ 501: [0, "no_miles_on_deal"], 900: [0, "no_miles_on_deal"] });
  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  assert.deepEqual(
    db.rows("quote_jobs").map(({ deal_id, status, kind, requested_by }) => ({ deal_id, status, kind, requested_by })),
    [{ deal_id: 501, status: "pending", kind: "miles", requested_by: "withers-time:no-miles-on-deal" }],
  );
  const one = q.submitted.find((i) => i.id === 1)!;
  assert.deepEqual(one.mileage_cap, { cap_cents_per_mile: 0, basis: "no_miles_on_deal" }, "nothing has failed yet");
  // Pending: a second load, or a second Approver, queues nothing more.
  assert.ok((await loadQueue(createClient(), MANAGER)).ok);
  db.signIn(OWNER.id);
  assert.ok((await loadQueue(createClient(), OWNER)).ok);
  assert.equal(db.rows("quote_jobs").length, 1);
});

test("loadQueue: a miles job of either kind, the time app's 'miles' or a manager's Recalculate, pending or recent, blocks a new one; a recent one that did not find the miles is a failure", async () => {
  caps({ 501: [0, "no_miles_on_deal"], 502: [0, "no_miles_on_deal"], 777: [0, "no_miles_on_deal"] });
  db.tables.quote_jobs = [
    recalcJob(1, 501, "pending", 5, "miles"),
    recalcJob(2, 502, "done", 20, "retriage"),
    recalcJob(3, 777, "error", 20, "picklist"),
  ];
  db.tables.travel_reimbursements.push(row(8, DONTE.id, { deal_id: 502 }));
  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  assert.deepEqual(queued().map((j) => [j.deal_id, j.kind]), [[777, "miles"]], "a picklist job neither blocks nor fails");
  assert.equal(q.submitted.find((i) => i.id === 1)!.mileage_cap?.recalc_failed, undefined, "pending, not failed");
  assert.equal(q.submitted.find((i) => i.id === 8)!.mileage_cap?.recalc_failed, true, "the manager's Recalculate finished without miles");
  assert.equal(q.approved.find((i) => i.id === 4)!.mileage_cap?.recalc_failed, undefined);
});

test("loadQueue: a Recalculate already pending or running for the deal, from anyone, is not queued again; another kind of job does not count", async () => {
  caps({ 501: [0, "no_miles_on_deal"], 777: [0, "no_miles_on_deal"] });
  db.tables.quote_jobs = [recalcJob(1, 501, "running", 300), recalcJob(2, 777, "pending", 1, "quote")];
  db.signIn(MANAGER.id);
  assert.ok((await loadQueue(createClient(), MANAGER)).ok);
  assert.deepEqual(queued().map((j) => j.deal_id), [777]);
});

test("loadQueue: a Recalculate that did not find the miles says so on the trip, and the next is queued only an hour after the last", async () => {
  caps({ 501: [0, "no_miles_on_deal"] });
  db.tables.quote_jobs = [recalcJob(1, 501, "error", 30)];
  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  assert.equal(queued().length, 0, "the last one was 30 minutes ago");
  assert.deepEqual(q.submitted.find((i) => i.id === 1)!.mileage_cap, { cap_cents_per_mile: 0, basis: "no_miles_on_deal", recalc_failed: true });
  assert.equal(q.approved.find((i) => i.id === 2)!.mileage_cap?.recalc_failed, true);

  db.tables.quote_jobs[0].created_at = minutesAgo(61);
  const later = await loadQueue(createClient(), MANAGER);
  assert.ok(later.ok);
  assert.equal(queued().length, 1, "an hour on, one more");
  assert.equal(later.submitted.find((i) => i.id === 1)!.mileage_cap?.recalc_failed, true, "the last finished one still failed");
});

test("loadQueue: once the miles land the deal is capped at the quote's rate and nothing is queued", async () => {
  caps({ 501: [72.5, "quote_derived"] });
  db.tables.quote_jobs = [recalcJob(1, 501, "done", 5)];
  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  assert.equal(db.rows("quote_jobs").length, 1);
  assert.deepEqual(q.submitted.find((i) => i.id === 1)!.mileage_cap, { cap_cents_per_mile: 72.5, basis: "quote_derived" });
});

test("loadQueue: when the Recalculate jobs cannot be read the queue still loads, the trip still capped at 0c", async () => {
  caps({ 501: [0, "no_miles_on_deal"] });
  db.missingTables = ["quote_jobs"];
  db.signIn(MANAGER.id);
  const q = await loadQueue(createClient(), MANAGER);
  assert.ok(q.ok);
  assert.equal(q.submitted.find((i) => i.id === 1)!.amounts.mileage_cents, 0);
});

test("loadMine: staff loading their page queue no Recalculate, but are told when the last one did not find the miles", async () => {
  caps({ 501: [0, "no_miles_on_deal"] });
  db.signIn(DONTE.id);
  const mine = await loadMine(createClient(), DONTE.id);
  assert.ok(mine.ok);
  assert.equal(db.rows("quote_jobs").length, 0);
  assert.deepEqual(mine.reimbursements[0].mileage_cap, { cap_cents_per_mile: 0, basis: "no_miles_on_deal" });

  db.tables.quote_jobs = [recalcJob(1, 501, "error", 10)];
  const after = await loadMine(createClient(), DONTE.id);
  assert.ok(after.ok);
  assert.equal(after.reimbursements[0].mileage_cap?.recalc_failed, true);
  assert.equal(db.rows("quote_jobs").length, 1);
});
