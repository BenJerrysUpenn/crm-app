// STORY (the owner, 2026-11-16; bj-finance #210; ruling 54, Catering Events):
// "Take the miles from the deal. Staff stop typing miles.
// The app pays the round trip Catering-Manager already saved for that event,
// under the existing pay cap."
//
// A staff member who drove their own car to a Catering Event types no miles.
// They are paid the deal's stored round-trip miles x the lower of the IRS rate
// for the trip date and the quote's per-mile rate (ruling 47); a quote that
// charged $0 mileage pays 0c a mile (ruling 50); a deal with no round-trip
// miles yet waits for them: a miles-only recalculation is queued and Approve
// is refused until they land (ruling 51), and then the trip is approved on
// the deal's miles. Groceries / errands keep typed or destination miles.
//
// Driven through the route handlers and page loaders, against the stand-in
// Supabase (lib/testing/fakeSupabase.ts). The database's copy (the trigger
// that writes the deal's miles, and the payable view payroll pays from) is
// supabase/migration_58_verify.sql.
//
//   npm test

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";
import { addDays } from "./coverage.ts";
import { dayKey } from "./format.ts";

type Handler = (request: Request, ctx?: { params: Record<string, string> }) => Promise<Response>;

const create = await loadAppModule<{ POST: Handler }>("app/api/reimbursements/route.ts");
const one = await loadAppModule<{ PATCH: Handler }>("app/api/reimbursements/[id]/route.ts");
const events = await loadAppModule<{ GET: Handler }>("app/api/reimbursements/events/route.ts");
const decide = await loadAppModule<{ POST: Handler }>("app/api/payroll/reimbursements/[id]/decide/route.ts");
const { loadMine, loadQueue } = await loadAppModule<typeof import("./reimbursements/load.ts")>("lib/reimbursements/load.ts");
const { createClient } = await loadAppModule<typeof import("./supabase/server.ts")>("lib/supabase/server.ts");
const { milesPending, noMilesRefusal } = await import("./reimbursements/money.ts");

const OWNER = "00000000-0000-0000-0000-0000000000a1";
const MANAGER = "00000000-0000-0000-0000-0000000000a2";
const DONTE = "00000000-0000-0000-0000-0000000000b1";

const TODAY = dayKey(new Date().toISOString());
const YESTERDAY = addDays(TODAY, -1);
// The IRS rate from 2026-07-01, in force on every trip date here.
const IRS = 76;

/** The deals: one per case. */
const QUOTED = 501; // quote charged 72.5c a mile; 6.43 round-trip miles
const NO_MILES = 502; // no quote; no round-trip miles yet
const ZERO_QUOTE = 503; // quote charged $0 mileage; 8 round-trip miles
const DEAR = 504; // quote charged 90.5c a mile, above the IRS rate; 10 round-trip miles

function req(method: string, body?: unknown, url = "http://time.test/api/reimbursements"): Request {
  return new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}
const post = (body: unknown) => new Request("http://finance.test/api/payroll/reimbursements/1/decide", { method: "POST", body: JSON.stringify(body) });
const at = (id: number) => ({ params: { id: String(id) } });

/** A Catering Event trip in the car, as the form sends it now: no miles. */
function trip(deal: number, over: Record<string, unknown> = {}) {
  return { reason: { kind: "catering_event", event_id: deal }, trip_date: YESTERDAY, mileage: { mode: "deal" }, ...over };
}

let db: FakeSupabase;
let routesCalls: number;

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  routesCalls = 0;
  const event = (id: number, round_trip_miles: number | null) => ({
    id, stage: "Event Complete", event_date: YESTERDAY, event_start_time: "14:00", company: `Company ${id}`, venue_name: null,
    venue_address: `${id} Market St`, round_trip_miles,
  });
  db = startFakeSupabase({
    profiles: [
      { id: OWNER, role: "manager", active: false, full_name: "Alina Owner", phone: null, notif_prefs: {} },
      { id: MANAGER, role: "manager", active: true, full_name: "Sophia Manager", phone: null, notif_prefs: {} },
      { id: DONTE, role: "employee", active: true, full_name: "Donte Driver", phone: null, notif_prefs: {} },
    ],
    mileage_rates: [
      { starts_on: "2026-01-01", cents_per_mile: 72.5 },
      { starts_on: "2026-07-01", cents_per_mile: IRS },
    ],
    deals: [event(QUOTED, 6.43), event(NO_MILES, null), event(ZERO_QUOTE, 8), event(DEAR, 10)],
    travel_reimbursements: [],
    travel_reimbursement_adjustments: [],
    lyft_ride_reports: [],
    notifications: [],
    quote_jobs: [],
  });
  // event_mileage_caps() as migrations 49, 50 and 52 answer it for these deals.
  const caps: Record<number, [number | null, string]> = {
    [QUOTED]: [72.5, "quoted_rate"],
    [NO_MILES]: [null, "no_quote"],
    [ZERO_QUOTE]: [0, "no_rate_on_quote"],
    [DEAR]: [90.5, "quoted_rate"],
  };
  db.rpc.event_mileage_caps = (args) =>
    ((args.p_deal_ids as number[]) ?? []).filter((id) => id in caps).map((id) => ({ deal_id: id, cap_cents_per_mile: caps[id][0], basis: caps[id][1] }));
  db.external = async (request) => {
    if (request.url.startsWith("https://routes.googleapis.com/")) routesCalls++;
    return new Response(JSON.stringify({ routes: [{ distanceMeters: 1609.344 * 40, legs: [{ distanceMeters: 1609.344 * 40 }] }] }));
  };
});

/** Donte's trip as his page shows it. */
async function mine(id: number) {
  db.signIn(DONTE);
  const page = await loadMine(createClient(), DONTE);
  assert.ok(page.ok);
  return page.reimbursements.find((r) => r.id === id)!;
}

async function submit(body: unknown): Promise<{ id: number; status: number }> {
  db.signIn(DONTE);
  const res = await create.POST(req("POST", body));
  const payload = await res.json();
  return { id: payload.reimbursement?.id, status: res.status };
}

// ---------- the deal's miles, never the staff member's ----------------------------------------

test("story: the picker shows each Catering Event's stored round-trip miles with its cap, for the form's read-only Mileage line", async () => {
  db.signIn(DONTE);
  const { events: list } = await (await events.GET(req("GET", undefined, "http://time.test/api/reimbursements/events"))).json();
  const byId = new Map(list.map((e: { id: number; mileage_cap: unknown }) => [e.id, e.mileage_cap]));
  assert.deepEqual(byId.get(QUOTED), { cap_cents_per_mile: 72.5, basis: "quoted_rate", round_trip_miles: 6.43 });
  assert.deepEqual(byId.get(NO_MILES), { cap_cents_per_mile: null, basis: "no_quote", round_trip_miles: null });
});

test("story: a Catering Event trip is paid the deal's round-trip miles x the quote's rate when it is below the IRS rate", async () => {
  const { id, status } = await submit(trip(QUOTED));
  assert.equal(status, 200);
  const stored = db.rows("travel_reimbursements").find((r) => r.id === id)!;
  assert.equal(stored.mileage_mode, "deal");
  assert.equal(Number(stored.miles), 6.4, "6.43 round-trip miles, to one decimal");
  const r = await mine(id);
  // 6.4 mi x min(76c IRS, 72.5c quote) = 464c.
  assert.equal(r.amounts.rate, 72.5);
  assert.equal(r.amounts.mileage_cents, 464);
  const notice = db.rows("notifications").find((n) => n.title === "Travel Reimbursement submitted")!;
  assert.match(String(notice.body), /, \$4\.64\. Approve/);
});

test("story: when the quote charged more a mile than the IRS rate, the IRS rate", async () => {
  const { id } = await submit(trip(DEAR));
  const r = await mine(id);
  assert.equal(r.amounts.rate, IRS);
  assert.equal(r.amounts.mileage_cents, 760, "10 mi x 76c (the IRS rate, below the quote's 90.5c)");
});

test("story: miles a staff member types or routes for a Catering Event are ignored: the server takes the deal's", async () => {
  const typed = await submit(trip(QUOTED, { mileage: { mode: "typed", miles: "99" } }));
  const routed = await submit(trip(QUOTED, { mileage: { mode: "destinations", stops: ["Far away"], start_at_store: true, end_at_store: true } }));
  assert.equal(typed.status, 200);
  assert.equal(routed.status, 200);
  for (const r of db.rows("travel_reimbursements")) {
    assert.equal(r.mileage_mode, "deal");
    assert.equal(Number(r.miles), 6.4);
    assert.equal(r.stops, null);
  }
  assert.equal(routesCalls, 0, "no route is computed for a Catering Event");
});

test("story: tolls and parking on a Catering Event are as before, on top of the deal's mileage", async () => {
  const { id } = await submit(trip(QUOTED, { tolls: "4.50", parking: "12.00", no_receipt_confirmed: true }));
  const r = await mine(id);
  assert.equal(r.amounts.total_cents, 2114, "$4.64 mileage + $4.50 tolls + $12.00 parking");
});

test("story: Groceries / errands still pay the typed miles at the IRS rate", async () => {
  const { id } = await submit({ reason: { kind: "errands", note: "Restaurant Depot" }, trip_date: YESTERDAY, mileage: { mode: "typed", miles: "10" } });
  const r = await mine(id);
  assert.equal(r.mileage_mode, "typed");
  assert.equal(r.amounts.mileage_cents, 760, "10 mi x 76c");
});

// ---------- a $0 mileage quote (ruling 50) ------------------------------------------------------

test("story: a quote that charged $0 mileage pays 0c a mile on the deal's miles, tolls and parking in full, and is approved", async () => {
  const { id } = await submit(trip(ZERO_QUOTE, { tolls: "4.50", no_receipt_confirmed: true }));
  const r = await mine(id);
  assert.equal(Number(r.miles), 8);
  assert.equal(r.amounts.mileage_cents, 0);
  assert.equal(r.amounts.total_cents, 450);
  assert.equal(milesPending(r), false);
  db.signIn(MANAGER);
  const res = await decide.POST(post({ action: "approve" }), at(id));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).reimbursement.amounts.total_cents, 450);
});

// ---------- the deal has no round-trip miles yet (ruling 51) --------------------------------------

test("story: a deal with no round-trip miles: the trip is accepted with nothing else to pay, a miles-only recalculation is queued, and Approve is refused", async () => {
  const { id, status } = await submit(trip(NO_MILES));
  assert.equal(status, 200, "nothing to pay yet is not refused: the miles are on their way");
  assert.deepEqual(
    db.rows("quote_jobs").map(({ deal_id, kind, status: s }) => ({ deal_id, kind, status: s })),
    [{ deal_id: NO_MILES, kind: "miles", status: "pending" }],
  );
  const r = await mine(id);
  assert.equal(Number(r.miles), 0);
  assert.equal(milesPending(r), true);

  db.signIn(MANAGER);
  const res = await decide.POST(post({ action: "approve" }), at(id));
  assert.equal(res.status, 409);
  assert.equal(
    (await res.json()).error,
    "Its Catering Event's deal has no round-trip miles yet, so its mileage cannot be priced. They are being recalculated automatically; once they are in, approve it.",
  );
  assert.equal(db.rows("travel_reimbursements")[0].status, "submitted");
});

test("story: once the deal's miles land the trip reprices on its next read and is approved on them; later changes to the deal do not move it", async () => {
  const { id } = await submit(trip(NO_MILES));
  db.tables.deals.find((d) => d.id === NO_MILES)!.round_trip_miles = 12.25;

  const r = await mine(id);
  assert.equal(Number(r.miles), 12.3);
  assert.equal(r.amounts.mileage_cents, 935, "12.3 mi x 76c (no quote: the IRS rate) = 934.8 -> 935");
  assert.equal(milesPending(r), false);

  db.signIn(MANAGER);
  const res = await decide.POST(post({ action: "approve" }), at(id));
  assert.equal(res.status, 200);
  const stored = db.rows("travel_reimbursements")[0];
  assert.equal(stored.status, "approved");
  assert.equal(Number(stored.miles), 12.3, "the miles it was approved on are written to it");

  db.tables.deals.find((d) => d.id === NO_MILES)!.round_trip_miles = 30;
  const q = await loadQueue(createClient(), { id: MANAGER, role: "manager", active: true });
  assert.ok(q.ok);
  const approved = q.approved.find((i) => i.id === id)!;
  assert.equal(Number(approved.miles), 12.3);
  assert.equal(approved.amounts.mileage_cents, 935);
});

test("story: a recalculation that finished without miles tells staff a manager will check the address, and the Approver to check the venue", async () => {
  db.tables.quote_jobs = [{ id: 7, deal_id: NO_MILES, status: "error", kind: "miles", created_at: new Date().toISOString(), requested_by: "withers-time:no-miles-on-deal" }];
  const { id } = await submit(trip(NO_MILES));
  const r = await mine(id);
  assert.equal(r.mileage_cap?.recalc_failed, true);
  assert.match(String(noMilesRefusal(r, "approve it")), /did not find them, so a manager should check the venue address on the deal/);
});

// ---------- trips submitted before the change ----------------------------------------------------

/** Donte's trip 1 as already on file: a Submitted Catering Event trip on deal 501's miles. */
function onFile(over: Record<string, unknown> = {}) {
  db.tables.travel_reimbursements.push({
    id: 1, profile_id: DONTE, reason_kind: "catering_event", deal_id: QUOTED, event_label: "Old label", event_date: YESTERDAY, reason_note: null,
    trip_date: YESTERDAY, mileage_mode: "deal", miles: 6.4, stops: null, start_at_store: null, end_at_store: null, route_legs: null,
    tolls_cents: 0, parking_cents: 0, mileage_cents_override: null, receipt_paths: [], no_receipt_confirmed: false, status: "submitted",
    rejection_reason: null, decided_by: null, decided_at: null, paid_on: null, paid_by: null, receipts_emailed_at: null,
    submitted_at: "2026-11-01T00:00:00Z", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
    ...over,
  });
}

test("story: a Catering Event trip typed before the change moves to the deal's miles when it is edited, dropping a Mileage Adjustment made on the typed miles", async () => {
  onFile({ mileage_mode: "typed", miles: 15, mileage_cents_override: 1000 });
  db.signIn(DONTE);
  const res = await one.PATCH(req("PATCH", trip(QUOTED, { mileage: { mode: "typed", miles: "15" } })), at(1));
  assert.equal(res.status, 200);
  const stored = db.rows("travel_reimbursements")[0];
  assert.equal(stored.mileage_mode, "deal");
  assert.equal(Number(stored.miles), 6.4);
  assert.equal(stored.mileage_cents_override, null);
  assert.equal((await mine(1)).amounts.mileage_cents, 464);
});

test("story: editing a Catering Event trip already on the deal's miles keeps an Approver's Mileage Adjustment: its miles did not change", async () => {
  onFile({ mileage_cents_override: 1000 });
  db.signIn(DONTE);
  const res = await one.PATCH(req("PATCH", trip(QUOTED, { tolls: "4.50", no_receipt_confirmed: true })), at(1));
  assert.equal(res.status, 200);
  const stored = db.rows("travel_reimbursements")[0];
  assert.equal(stored.mileage_cents_override, 1000);
  assert.equal((await mine(1)).amounts.total_cents, 1450, "the $10.00 Adjustment + $4.50 tolls");
});

test("story: moving a deal-miles trip to Groceries / errands is a change of miles, even at the same number: the Mileage Adjustment is dropped", async () => {
  onFile({ mileage_cents_override: 1000 });
  db.signIn(DONTE);
  const res = await one.PATCH(req("PATCH", { reason: { kind: "errands", note: "Restaurant Depot" }, trip_date: YESTERDAY, mileage: { mode: "typed", miles: "6.4" } }), at(1));
  assert.equal(res.status, 200);
  const stored = db.rows("travel_reimbursements")[0];
  assert.equal(stored.mileage_mode, "typed");
  assert.equal(stored.mileage_cents_override, null);
  assert.equal((await mine(1)).amounts.mileage_cents, 486, "6.4 mi x 76c = 486.4 -> 486");
});

test("story: a Rejected Catering Event trip also follows the deal's miles once they land", async () => {
  onFile({ deal_id: NO_MILES, miles: 0, status: "rejected", rejection_reason: "Wrong date" });
  db.tables.deals.find((d) => d.id === NO_MILES)!.round_trip_miles = 12.25;
  const r = await mine(1);
  assert.equal(Number(r.miles), 12.3);
  assert.equal(r.amounts.mileage_cents, 935, "12.3 mi x 76c = 934.8 -> 935");
});

test("story: when the deals' round-trip miles cannot be read, the page says so rather than pricing the trip at no miles", async () => {
  onFile();
  db.missingColumns = { deals: ["round_trip_miles"] };
  db.signIn(DONTE);
  const page = await loadMine(createClient(), DONTE);
  assert.equal(page.ok, false);
  assert.match(String((page as { error: string }).error), /round-trip miles could not be read/);
});
