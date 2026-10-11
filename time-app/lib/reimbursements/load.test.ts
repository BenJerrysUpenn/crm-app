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
