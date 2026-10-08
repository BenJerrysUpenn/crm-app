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
    profiles: [OWNER, MANAGER, DONTE, SAM],
    mileage_rates: [{ starts_on: "2026-01-01", cents_per_mile: 72.5 }, { starts_on: "2026-07-01", cents_per_mile: 76 }],
    travel_reimbursements: [
      row(1, DONTE.id),
      row(2, SAM.id, { miles: 12.1, status: "approved" }),
      row(3, MANAGER.id, { deal_id: null, reason_kind: "errands", trip_date: "2026-06-30" }),
      row(4, OWNER.id, { deal_id: 777, status: "approved" }),
      row(5, SAM.id, { status: "paid" }),
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
