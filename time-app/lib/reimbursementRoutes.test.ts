// Staff's side of Travel Reimbursements (bj-finance #210), driven through the
// route handlers the Reimbursements page calls, against the stand-in Supabase
// (lib/testing/fakeSupabase.ts). The database's own copy of these rules is
// supabase/migration_37_verify.sql.
//
//   npm test

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";
import { addDays } from "./coverage.ts";
import { dayKey } from "./format.ts";

type Handler = (request: Request, ctx?: { params: Record<string, string> }) => Promise<Response>;

const create = await loadAppModule<{ POST: Handler }>("app/api/reimbursements/route.ts");
const one = await loadAppModule<{ PATCH: Handler; DELETE: Handler }>("app/api/reimbursements/[id]/route.ts");
const events = await loadAppModule<{ GET: Handler }>("app/api/reimbursements/events/route.ts");
const uploadUrl = await loadAppModule<{ POST: Handler }>("app/api/reimbursements/upload-url/route.ts");
const lyft = await loadAppModule<{ POST: Handler }>("app/api/reimbursements/lyft/route.ts");
const file = await loadAppModule<{ GET: Handler }>("app/api/reimbursements/file/route.ts");
const routeMilesApi = await loadAppModule<{ POST: Handler }>("app/api/reimbursements/route-miles/route.ts");

const OWNER = "00000000-0000-0000-0000-0000000000a1";
const MANAGER = "00000000-0000-0000-0000-0000000000a2";
const DONTE = "00000000-0000-0000-0000-0000000000b1";
const SAM = "00000000-0000-0000-0000-0000000000b2";

const TODAY = dayKey(new Date().toISOString());
const YESTERDAY = addDays(TODAY, -1);

function req(method: string, body?: unknown, url = "http://time.test/api/reimbursements"): Request {
  return new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

const errands = {
  reason: { kind: "errands", note: "Restaurant Depot, cones" },
  trip_date: YESTERDAY,
  mileage: { mode: "typed", miles: "10" },
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1, profile_id: DONTE, reason_kind: "errands", deal_id: null, event_label: null, event_date: null,
    reason_note: "Depot", trip_date: YESTERDAY, mileage_mode: "typed", miles: 10, stops: null, start_at_store: null, end_at_store: null,
    route_legs: null, tolls_cents: 0, parking_cents: 0, mileage_cents_override: null, receipt_paths: [],
    no_receipt_confirmed: false, status: "submitted", rejection_reason: null, decided_by: null, decided_at: null,
    paid_on: null, paid_by: null, receipts_emailed_at: null, submitted_at: "2026-10-01T00:00:00Z",
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...over,
  };
}

let db: FakeSupabase;
let sent: { url: string; body: Record<string, unknown> }[];
// What Resend and Google answer with.
let resendStatus: number;
let googleStatus: number;

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  sent = [];
  resendStatus = 200;
  googleStatus = 200;
  db = startFakeSupabase({
    profiles: [
      { id: OWNER, role: "manager", active: false, full_name: "Alina Owner", phone: null, notif_prefs: {} },
      { id: MANAGER, role: "manager", active: true, full_name: "Sophia Manager", phone: null, notif_prefs: {} },
      { id: DONTE, role: "employee", active: true, full_name: "Donte Driver", phone: null, notif_prefs: {} },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee", phone: null, notif_prefs: {} },
    ],
    mileage_rates: [
      { starts_on: "2025-01-01", cents_per_mile: 70 },
      { starts_on: "2026-01-01", cents_per_mile: 72.5 },
      { starts_on: "2026-07-01", cents_per_mile: 76 },
    ],
    deals: [
      { id: 501, stage: "Event Complete", event_date: YESTERDAY, event_start_time: "14:00", company: "Acme", venue_name: "Houston Hall", venue_address: "3417 Spruce St" },
      { id: 502, stage: "Booked Paid", event_date: addDays(TODAY, 3), event_start_time: "10:00", company: "Future Co", venue_name: null, venue_address: "1 Market St" },
      { id: 503, stage: "Booked Paid", event_date: addDays(TODAY, -400), event_start_time: "10:00", company: "Old Co", venue_name: null, venue_address: "2 Market St" },
      { id: 504, stage: "Closed Lost", event_date: YESTERDAY, event_start_time: "10:00", company: "Lost Co", venue_name: null, venue_address: "3 Market St" },
      { id: 505, stage: "Booked Unpaid", event_date: addDays(TODAY, -2), event_start_time: "18:00", company: "Burlington Coat", venue_name: "HQ", venue_address: "1830 Route 130, Burlington NJ" },
    ],
    travel_reimbursements: [],
    travel_reimbursement_adjustments: [],
    lyft_ride_reports: [],
    notifications: [],
  });
  db.external = async (request) => {
    const body = JSON.parse(await request.text());
    sent.push({ url: request.url, body });
    if (request.url.startsWith("https://routes.googleapis.com/")) {
      if (googleStatus !== 200) return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: googleStatus });
      const legs = 1 + (body.intermediates?.length ?? 0);
      return new Response(JSON.stringify({ routes: [{ legs: Array.from({ length: legs }, () => ({ distanceMeters: 1609.344 * 2.04 })) }] }));
    }
    return new Response("{}", { status: resendStatus });
  };
});

// ---------- the Catering Event picker -------------------------------------------------

test("events: staff see booked Catering Events of the last 365 days up to today, newest first, labelled without deal ids", async () => {
  db.signIn(DONTE);
  const res = await events.GET(req("GET", undefined, "http://time.test/api/reimbursements/events"));
  assert.equal(res.status, 200);
  const { events: list } = await res.json();
  assert.deepEqual(list.map((e: { id: number }) => e.id), [501, 505]);
  assert.match(list[0].label, /2:00 PM, Acme at Houston Hall, 3417 Spruce St$/);
  for (const e of list) assert.doesNotMatch(e.label, /50\d/);
  assert.equal(list[0].date, YESTERDAY);
});

test("events: searchable by venue, company or address", async () => {
  db.signIn(DONTE);
  const res = await events.GET(req("GET", undefined, "http://time.test/api/reimbursements/events?q=burlington"));
  assert.deepEqual((await res.json()).events.map((e: { id: number }) => e.id), [505]);
});

test("events: signed out is refused", async () => {
  const res = await events.GET(req("GET", undefined, "http://time.test/api/reimbursements/events"));
  assert.equal(res.status, 401);
});

// ---------- submit -----------------------------------------------------------------------

test("submit: typed miles for errands is Submitted, and every Approver but the submitter hears of it", async () => {
  db.signIn(DONTE);
  const res = await create.POST(req("POST", errands));
  assert.equal(res.status, 200);
  const [r] = db.rows("travel_reimbursements");
  assert.equal(r.profile_id, DONTE);
  assert.equal(r.status, "submitted");
  assert.equal(r.miles, 10);
  assert.equal(r.reason_note, "Restaurant Depot, cones");
  const notified = db.rows("notifications").map((n) => [n.user_id, n.type, n.title]);
  assert.deepEqual(notified, [
    [OWNER, "reimbursement_submitted", "Travel Reimbursement submitted"],
    [MANAGER, "reimbursement_submitted", "Travel Reimbursement submitted"],
  ]);
  assert.match(String(db.rows("notifications")[0].body), /^Donte Driver: Groceries \/ errands: Restaurant Depot, cones/);
});

test("submit: a manager's own goes to the owners, not to the manager", async () => {
  db.signIn(MANAGER);
  assert.equal((await create.POST(req("POST", errands))).status, 200);
  assert.deepEqual(db.rows("notifications").map((n) => n.user_id), [OWNER]);
});

test("submit: a non-owner manager's goes to the owners only, never to another manager (ruling 28)", async () => {
  const MIRA = "00000000-0000-0000-0000-0000000000a3";
  db.tables.profiles.push({ id: MIRA, role: "manager", active: true, full_name: "Mira Manager", phone: null, notif_prefs: {} });
  db.signIn(MANAGER);
  assert.equal((await create.POST(req("POST", errands))).status, 200);
  assert.deepEqual(db.rows("notifications").map((n) => n.user_id), [OWNER]);
});

test("submit: a Catering Event records how staff saw it, and the trip date is theirs", async () => {
  db.signIn(DONTE);
  const res = await create.POST(req("POST", { ...errands, reason: { kind: "catering_event", event_id: 501 } }));
  assert.equal(res.status, 200);
  const [r] = db.rows("travel_reimbursements");
  assert.equal(r.reason_kind, "catering_event");
  assert.equal(r.deal_id, 501);
  assert.equal(r.event_date, YESTERDAY);
  assert.match(String(r.event_label), /Acme at Houston Hall, 3417 Spruce St$/);
});

test("submit: a Catering Event outside the picker (future, too old, not booked) is refused", async () => {
  db.signIn(DONTE);
  for (const id of [502, 503, 504, 999]) {
    const res = await create.POST(req("POST", { ...errands, reason: { kind: "catering_event", event_id: id } }));
    assert.equal(res.status, 400, `event ${id}`);
  }
  assert.equal(db.rows("travel_reimbursements").length, 0);
});

test("submit: tolls with no Receipt asks to confirm, then is accepted", async () => {
  db.signIn(DONTE);
  const ask = await create.POST(req("POST", { ...errands, tolls: "4.50" }));
  assert.equal(ask.status, 409);
  assert.deepEqual(await ask.json(), { error: "Are you sure there is no receipt?", confirm: "no_receipt" });
  assert.equal(db.rows("travel_reimbursements").length, 0);
  const yes = await create.POST(req("POST", { ...errands, tolls: "4.50", no_receipt_confirmed: true }));
  assert.equal(yes.status, 200);
  assert.equal(db.rows("travel_reimbursements")[0].tolls_cents, 450);
  assert.equal(db.rows("travel_reimbursements")[0].no_receipt_confirmed, true);
});

test("submit: Receipts are the staff member's own uploads", async () => {
  db.signIn(DONTE);
  const bad = await create.POST(req("POST", { ...errands, parking: "8", receipt_paths: [`${SAM}/receipts/1.jpg`] }));
  assert.equal(bad.status, 400);
  const ok = await create.POST(req("POST", { ...errands, parking: "8", receipt_paths: [`${DONTE}/receipts/1.jpg`] }));
  assert.equal(ok.status, 200);
  assert.deepEqual(db.rows("travel_reimbursements")[0].receipt_paths, [`${DONTE}/receipts/1.jpg`]);
});

test("submit: destinations mode computes the miles on the server, from the store and back", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "maps-key";
  db.signIn(DONTE);
  const res = await create.POST(req("POST", { ...errands, mileage: { mode: "destinations", stops: ["Restaurant Depot"], miles: "999" } }));
  assert.equal(res.status, 200);
  const [r] = db.rows("travel_reimbursements");
  assert.equal(r.mileage_mode, "destinations");
  assert.equal(r.miles, 4, "two legs of 2.04 mi, each rounded to 2.0");
  assert.deepEqual(r.stops, ["Restaurant Depot"]);
  assert.equal(r.start_at_store, true);
  assert.equal(r.end_at_store, true);
  assert.equal((r.route_legs as unknown[]).length, 2);
  const google = sent.find((s) => s.url.startsWith("https://routes.googleapis.com/"));
  assert.deepEqual(google?.body.destination, { address: "218 S 40th St, Philadelphia, PA 19104" });
});

test("submit: destinations mode when Google cannot route the trip is refused, with nothing written and nobody told", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "maps-key";
  googleStatus = 403;
  db.signIn(DONTE);
  const res = await create.POST(req("POST", { ...errands, mileage: { mode: "destinations", stops: ["Restaurant Depot"], miles: "999" } }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /type the miles/);
  assert.equal(db.rows("travel_reimbursements").length, 0);
  assert.equal(db.rows("notifications").length, 0);
});

test("submit: Start at the store off pays only from the first stop (home -> Depot -> store is Depot -> store)", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "maps-key";
  db.signIn(DONTE);
  const res = await create.POST(req("POST", { ...errands, mileage: { mode: "destinations", stops: ["Restaurant Depot"], start_at_store: false } }));
  assert.equal(res.status, 200);
  const [r] = db.rows("travel_reimbursements");
  assert.equal(r.miles, 2, "one leg of 2.04 mi");
  assert.equal(r.start_at_store, false);
  assert.equal(r.end_at_store, true);
  assert.deepEqual(r.route_legs, [{ from: "Restaurant Depot", to: "218 S 40th St, Philadelphia, PA 19104", miles: 2 }]);
  const google = sent.find((s) => s.url.startsWith("https://routes.googleapis.com/"));
  assert.deepEqual(google?.body.origin, { address: "Restaurant Depot" });
});

test("submit and route-miles: with neither end at the store, one stop is refused", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "maps-key";
  db.signIn(DONTE);
  const mileage = { mode: "destinations", stops: ["Restaurant Depot"], start_at_store: false, end_at_store: false };
  assert.equal((await create.POST(req("POST", { ...errands, mileage }))).status, 400);
  assert.equal(db.rows("travel_reimbursements").length, 0);
  const preview = await routeMilesApi.POST(req("POST", { stops: ["Restaurant Depot"], start_at_store: false, end_at_store: false }));
  assert.equal(preview.status, 400);
  const two = await routeMilesApi.POST(req("POST", { stops: ["Home", "Restaurant Depot"], start_at_store: false, end_at_store: false }));
  assert.equal(two.status, 200);
  assert.deepEqual((await two.json()).legs, [{ from: "Home", to: "Restaurant Depot", miles: 2 }]);
});

test("route-miles: previews the computed miles; without a Maps key it says to type them", async () => {
  db.signIn(DONTE);
  const none = await routeMilesApi.POST(req("POST", { stops: ["A"] }));
  assert.equal(none.status, 400);
  assert.match((await none.json()).error, /Type the miles/);
  process.env.GOOGLE_MAPS_API_KEY = "maps-key";
  const ok = await routeMilesApi.POST(req("POST", { stops: ["A"], end_at_store: false }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).miles, 2);
});

test("submit: before migration 37 the page says so", async () => {
  db.missingTables.push("travel_reimbursements", "mileage_rates");
  db.signIn(DONTE);
  const res = await create.POST(req("POST", errands));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /migration 37/);
});

// ---------- edit, resubmit, delete --------------------------------------------------------

test("edit: staff change their own while Submitted", async () => {
  db.tables.travel_reimbursements.push(row());
  db.signIn(DONTE);
  const res = await one.PATCH(req("PATCH", { ...errands, mileage: { mode: "typed", miles: "12.5" } }), { params: { id: "1" } });
  assert.equal(res.status, 200);
  assert.equal(db.rows("travel_reimbursements")[0].miles, 12.5);
  assert.equal(db.rows("notifications").length, 0, "an edit while Submitted is not a new submission");
});

test("edit: changing the miles drops an Adjustment's mileage amount; the new miles need deciding again", async () => {
  db.tables.travel_reimbursements.push(row({ mileage_cents_override: 500 }));
  db.signIn(DONTE);
  await one.PATCH(req("PATCH", { ...errands, mileage: { mode: "typed", miles: "12.5" } }), { params: { id: "1" } });
  assert.equal(db.rows("travel_reimbursements")[0].mileage_cents_override, null);
});

test("edit: a Rejected one is fixed and resubmitted, and the Approvers hear of it again", async () => {
  db.tables.travel_reimbursements.push(row({ status: "rejected", rejection_reason: "Which store?" }));
  db.signIn(DONTE);
  const res = await one.PATCH(req("PATCH", errands), { params: { id: "1" } });
  assert.equal(res.status, 200);
  assert.equal(db.rows("travel_reimbursements")[0].status, "submitted");
  assert.equal(db.rows("notifications").length, 2);
});

test("edit: when the Catering Events cannot be read, the route says so and the edit is not written", async () => {
  db.tables.travel_reimbursements.push(row());
  db.missingTables = ["deals"];
  db.signIn(DONTE);
  const res = await one.PATCH(req("PATCH", { ...errands, reason: { kind: "catering_event", event_id: 501 } }), { params: { id: "1" } });
  assert.equal(res.status, 503);
  assert.doesNotMatch((await res.json()).error, /not in the list/);
  assert.equal(db.rows("travel_reimbursements")[0].reason_kind, "errands");
});

test("edit and delete: an Approved or Paid one is locked to staff", async () => {
  db.tables.travel_reimbursements.push(row({ id: 1, status: "approved" }), row({ id: 2, status: "paid", paid_on: "2026-10-07" }));
  db.signIn(DONTE);
  for (const id of ["1", "2"]) {
    assert.equal((await one.PATCH(req("PATCH", errands), { params: { id } })).status, 409, `edit ${id}`);
    assert.equal((await one.DELETE(req("DELETE"), { params: { id } })).status, 409, `delete ${id}`);
  }
  assert.equal(db.rows("travel_reimbursements").length, 2);
});

test("edit and delete: someone else's is not found", async () => {
  db.tables.travel_reimbursements.push(row({ profile_id: SAM }));
  db.signIn(DONTE);
  assert.equal((await one.PATCH(req("PATCH", errands), { params: { id: "1" } })).status, 404);
  assert.equal((await one.DELETE(req("DELETE"), { params: { id: "1" } })).status, 404);
});

test("delete: staff delete their own while Submitted or Rejected", async () => {
  db.tables.travel_reimbursements.push(row({ id: 1 }), row({ id: 2, status: "rejected", rejection_reason: "x" }));
  db.signIn(DONTE);
  assert.equal((await one.DELETE(req("DELETE"), { params: { id: "1" } })).status, 200);
  assert.equal((await one.DELETE(req("DELETE"), { params: { id: "2" } })).status, 200);
  assert.equal(db.rows("travel_reimbursements").length, 0);
});

// ---------- uploads and files ----------------------------------------------------------------

test("upload-url: a signed upload into the staff member's own folder", async () => {
  db.signIn(DONTE);
  const res = await uploadUrl.POST(req("POST", { kind: "receipts", ext: "jpg", content_type: "image/jpeg" }));
  assert.equal(res.status, 200);
  const { path, token } = await res.json();
  assert.match(path, new RegExp(`^${DONTE}/receipts/\\d+-\\w+\\.jpg$`));
  assert.ok(token);
  assert.deepEqual(db.signedUploads, [`travel-reimbursements/${path}`]);
  const bad = await uploadUrl.POST(req("POST", { kind: "receipts", ext: "html", content_type: "text/html" }));
  assert.equal(bad.status, 400);
  const evidence = await uploadUrl.POST(req("POST", { kind: "evidence", ext: "png", content_type: "image/png" }));
  assert.equal(evidence.status, 400, "evidence is the Approvers' upload");
});

test("file: staff open their own upload, never someone else's", async () => {
  db.storage[`travel-reimbursements/${DONTE}/receipts/a.jpg`] = new Uint8Array([1]);
  db.storage[`travel-reimbursements/${SAM}/receipts/b.jpg`] = new Uint8Array([2]);
  db.signIn(DONTE);
  const mine = await file.GET(req("GET", undefined, `http://time.test/api/reimbursements/file?path=${DONTE}/receipts/a.jpg`));
  assert.equal(mine.status, 307);
  assert.match(mine.headers.get("location") ?? "", /\/storage\/v1\/object\/sign\/travel-reimbursements\//);
  const theirs = await file.GET(req("GET", undefined, `http://time.test/api/reimbursements/file?path=${SAM}/receipts/b.jpg`));
  assert.equal(theirs.status, 404);
});

// ---------- Lyft ride reports ------------------------------------------------------------------

test("Lyft: a ride report is Filed at once, emailed to receipts@ with its screenshots, and never queued for approval", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const shot = `${DONTE}/lyft/1-a.png`;
  db.storage[`travel-reimbursements/${shot}`] = new TextEncoder().encode("png bytes");
  db.signIn(DONTE);
  const res = await lyft.POST(req("POST", { reason: { kind: "catering_event", event_id: 501 }, trip_date: YESTERDAY, screenshot_paths: [shot] }));
  assert.equal(res.status, 200);
  const [report] = db.rows("lyft_ride_reports");
  assert.equal(report.profile_id, DONTE);
  assert.ok(report.emailed_at, "stamped as emailed");
  assert.equal(db.rows("travel_reimbursements").length, 0);
  assert.equal(db.rows("notifications").length, 0, "nothing for an Approver to decide");
  const mail = sent.find((s) => s.url === "https://api.resend.com/emails");
  assert.equal(mail?.body.to, "receipts@withers-ventures.com");
  assert.equal(mail?.body.subject, `[Withers Time] Lyft ride report: Donte Driver, ${YESTERDAY}`);
  assert.match(String(mail?.body.text), /^Kind: Lyft ride report\nEmployee: Donte Driver\nReason: Catering Event: /);
  assert.deepEqual(mail?.body.attachments, [{ filename: "1-a.png", content: Buffer.from("png bytes").toString("base64") }]);
});

test("Lyft: when receipts@ cannot be emailed the report is still Filed, and not stamped as emailed", async () => {
  process.env.RESEND_API_KEY = "re_test";
  resendStatus = 500;
  const shot = `${DONTE}/lyft/1-a.png`;
  db.storage[`travel-reimbursements/${shot}`] = new TextEncoder().encode("png bytes");
  db.signIn(DONTE);
  const res = await lyft.POST(req("POST", { reason: { kind: "errands", note: "Depot" }, trip_date: YESTERDAY, screenshot_paths: [shot] }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).emailed, false);
  const [report] = db.rows("lyft_ride_reports");
  assert.equal(report.profile_id, DONTE);
  assert.equal(report.emailed_at, null);
});

test("Lyft: a refused send to receipts@ is said in the response", async () => {
  process.env.RESEND_API_KEY = "re_test";
  resendStatus = 500;
  const shot = `${DONTE}/lyft/1-a.png`;
  db.storage[`travel-reimbursements/${shot}`] = new TextEncoder().encode("png bytes");
  db.signIn(DONTE);
  const body = await (await lyft.POST(req("POST", { reason: { kind: "errands", note: "Depot" }, trip_date: YESTERDAY, screenshot_paths: [shot] }))).json();
  assert.equal(body.emailed, false);
  assert.match(body.email_error, /could not be emailed to receipts@/);
});

test("Lyft: when the report went to receipts@ but its stamp cannot be written, the response says so", async () => {
  process.env.RESEND_API_KEY = "re_test";
  db.missingColumns.lyft_ride_reports = ["emailed_at"];
  const shot = `${DONTE}/lyft/1-a.png`;
  db.storage[`travel-reimbursements/${shot}`] = new TextEncoder().encode("png bytes");
  db.signIn(DONTE);
  const res = await lyft.POST(req("POST", { reason: { kind: "errands", note: "Depot" }, trip_date: YESTERDAY, screenshot_paths: [shot] }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.emailed, true);
  assert.match(body.email_error, /went to receipts@, but recording that failed/);
  assert.equal(db.rows("lyft_ride_reports").length, 1, "still Filed");
});

test("submit and Lyft: when the Catering Events cannot be read, the route says so, not that the event is not in the list", async () => {
  db.missingTables = ["deals"];
  db.signIn(DONTE);
  const catering = { reason: { kind: "catering_event", event_id: 501 }, trip_date: YESTERDAY };
  for (const res of [
    await create.POST(req("POST", { ...errands, ...catering })),
    await lyft.POST(req("POST", { ...catering, screenshot_paths: [`${DONTE}/lyft/1-a.png`] })),
  ]) {
    assert.equal(res.status, 503);
    assert.doesNotMatch((await res.json()).error, /not in the list/);
  }
  assert.equal(db.rows("travel_reimbursements").length, 0);
  assert.equal(db.rows("lyft_ride_reports").length, 0);
});

test("Lyft: needs a screenshot of the staff member's own", async () => {
  db.signIn(DONTE);
  const res = await lyft.POST(req("POST", { reason: { kind: "errands", note: "Depot" }, trip_date: YESTERDAY, screenshot_paths: [] }));
  assert.equal(res.status, 400);
  assert.equal(db.rows("lyft_ride_reports").length, 0);
});
