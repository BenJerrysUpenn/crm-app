// The Approver's side of Travel Reimbursements (bj-finance #210), on the
// Reimbursements tab of Withers Finance: approve, reject with a reason, send
// back, Paid outside payroll for an owner's, and Adjustments with evidence.
// Driven through the route handlers against lib/testing/fakeSupabase.ts; the
// database's copy is supabase/migration_37_verify.sql.
//
//   npm test

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";
import { dayKey } from "./format.ts";

type Handler = (request: Request, ctx?: { params: Record<string, string> }) => Promise<Response>;

const decide = await loadAppModule<{ POST: Handler }>("app/api/payroll/reimbursements/[id]/decide/route.ts");
const adjust = await loadAppModule<{ POST: Handler }>("app/api/payroll/reimbursements/[id]/adjust/route.ts");
const evidenceUrl = await loadAppModule<{ POST: Handler }>("app/api/payroll/reimbursements/evidence-url/route.ts");
const financeFile = await loadAppModule<{ GET: Handler }>("app/api/payroll/reimbursements/file/route.ts");

const OWNER = "00000000-0000-0000-0000-0000000000a1";
const OWNER2 = "00000000-0000-0000-0000-0000000000a3";
const MANAGER = "00000000-0000-0000-0000-0000000000a2";
const MANAGER2 = "00000000-0000-0000-0000-0000000000a4";
const DONTE = "00000000-0000-0000-0000-0000000000b1";

const TODAY = dayKey(new Date().toISOString());

function post(body: unknown): Request {
  return new Request("http://finance.test/api/payroll/reimbursements/1/x", { method: "POST", body: JSON.stringify(body) });
}
const ID = { params: { id: "1" } };

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1, profile_id: DONTE, reason_kind: "catering_event", deal_id: 501, event_label: "Sat Oct 3, 2026, 2:00 PM, Acme", event_date: "2026-10-03",
    reason_note: null, trip_date: "2026-10-03", mileage_mode: "typed", miles: 10, stops: null, start_at_store: null, end_at_store: null,
    route_legs: null, tolls_cents: 450, parking_cents: 800, mileage_cents_override: null, receipt_paths: [`${DONTE}/receipts/1-a.jpg`],
    no_receipt_confirmed: false, status: "submitted", rejection_reason: null, decided_by: null, decided_at: null,
    paid_on: null, paid_by: null, receipts_emailed_at: null, submitted_at: "2026-10-04T00:00:00Z",
    created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:00:00Z", ...over,
  };
}

let db: FakeSupabase;
let sent: { url: string; body: Record<string, unknown> }[];
// The status Resend answers with.
let resendStatus: number;

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  sent = [];
  resendStatus = 200;
  db = startFakeSupabase({
    profiles: [
      { id: OWNER, role: "manager", active: false, full_name: "Alina Owner", phone: null, notif_prefs: {} },
      { id: OWNER2, role: "manager", active: false, full_name: "Alex Owner", phone: null, notif_prefs: {} },
      { id: MANAGER, role: "manager", active: true, full_name: "Sophia Manager", phone: null, notif_prefs: {} },
      { id: MANAGER2, role: "manager", active: true, full_name: "Mira Manager", phone: null, notif_prefs: {} },
      { id: DONTE, role: "employee", active: true, full_name: "Donte Driver", phone: null, notif_prefs: {} },
    ],
    mileage_rates: [
      { starts_on: "2026-01-01", cents_per_mile: 72.5 },
      { starts_on: "2026-07-01", cents_per_mile: 76 },
    ],
    travel_reimbursements: [row()],
    travel_reimbursement_adjustments: [],
    notifications: [],
  });
  db.storage[`travel-reimbursements/${DONTE}/receipts/1-a.jpg`] = new TextEncoder().encode("jpeg");
  db.storage["travel-reimbursements/adjustments/1/9-e.png"] = new TextEncoder().encode("evidence");
  db.external = async (request) => {
    sent.push({ url: request.url, body: JSON.parse(await request.text()) });
    return new Response("{}", { status: resendStatus });
  };
});

const r1 = () => db.rows("travel_reimbursements")[0];
const resendMails = () => sent.filter((s) => s.url === "https://api.resend.com/emails");

// ---------- approve ---------------------------------------------------------------------

test("approve: Approved, decided by the Approver, Receipts emailed to receipts@ once; no notice to staff", async () => {
  db.signIn(MANAGER);
  const res = await decide.POST(post({ action: "approve" }), ID);
  assert.equal(res.status, 200);
  assert.equal(r1().status, "approved");
  assert.equal(r1().decided_by, MANAGER);
  assert.ok(r1().receipts_emailed_at);
  const [mail] = resendMails();
  assert.equal(mail.body.to, "receipts@withers-ventures.com");
  assert.equal(mail.body.subject, "[Withers Time] Travel Reimbursement receipt: Donte Driver, 2026-10-03, $12.50");
  assert.equal(
    mail.body.text,
    [
      "Kind: Travel Reimbursement receipt",
      "Employee: Donte Driver",
      "Reason: Catering Event: Sat Oct 3, 2026, 2:00 PM, Acme",
      "Trip date: 2026-10-03",
      "Tolls: $4.50",
      "Parking: $8.00",
      "Amount: $12.50",
      "Travel Reimbursement total: $20.10",
      "Travel Reimbursement ID: 1",
      "Attachments: 1",
      "",
      "Approved in Withers Time. Paid on the employee's own card and reimbursed via payroll: never match this receipt to a bank or card line (crm-app docs/adr/0001).",
    ].join("\n"),
  );
  assert.deepEqual(mail.body.attachments, [{ filename: "1-a.jpg", content: Buffer.from("jpeg").toString("base64") }]);
  assert.equal(db.rows("notifications").length, 0, "no notice on Approved");
});

test("approve: no Receipts, no email; Receipts already sent are not sent again", async () => {
  db.tables.travel_reimbursements = [row({ receipt_paths: [], no_receipt_confirmed: true }), row({ id: 2, status: "approved", receipts_emailed_at: "2026-10-05T00:00:00Z" })];
  db.signIn(MANAGER);
  assert.equal((await decide.POST(post({ action: "approve" }), ID)).status, 200);
  assert.equal((await decide.POST(post({ action: "send_back" }), { params: { id: "2" } })).status, 200);
  assert.equal((await decide.POST(post({ action: "approve" }), { params: { id: "2" } })).status, 200);
  assert.equal(resendMails().length, 0);
});

test("approve: when receipts@ cannot be emailed it is still Approved, not stamped as sent, and the next approval sends the Receipts", async () => {
  resendStatus = 500;
  db.signIn(MANAGER);
  const res = await decide.POST(post({ action: "approve" }), ID);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).receipts_emailed, false);
  assert.equal(r1().status, "approved");
  assert.equal(r1().receipts_emailed_at, null);
  resendStatus = 200;
  assert.equal((await decide.POST(post({ action: "send_back" }), ID)).status, 200);
  const again = await decide.POST(post({ action: "approve" }), ID);
  assert.equal((await again.json()).receipts_emailed, true);
  assert.ok(r1().receipts_emailed_at);
  assert.equal(resendMails().length, 2, "the refused send and the one that went");
});

test("approve: a refused send to receipts@ is said in the response, not passed over", async () => {
  resendStatus = 500;
  db.signIn(MANAGER);
  const body = await (await decide.POST(post({ action: "approve" }), ID)).json();
  assert.equal(body.receipts_emailed, false);
  assert.match(body.receipts_error, /could not be emailed to receipts@/);
});

test("approve: a Receipt missing from Storage is not emailed, and the response names it", async () => {
  delete db.storage[`travel-reimbursements/${DONTE}/receipts/1-a.jpg`];
  db.signIn(MANAGER);
  const res = await decide.POST(post({ action: "approve" }), ID);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.receipts_emailed, false);
  assert.match(body.receipts_error, /1-a\.jpg/);
  assert.equal(r1().status, "approved");
  assert.equal(r1().receipts_emailed_at, null);
  assert.equal(resendMails().length, 0);
});

test("approve: when the Receipts went but their stamp cannot be written, the response says so (a second approval would send them again)", async () => {
  db.missingColumns.travel_reimbursements = ["receipts_emailed_at"];
  db.signIn(MANAGER);
  const res = await decide.POST(post({ action: "approve" }), ID);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.receipts_emailed, true);
  assert.match(body.receipts_error, /went to receipts@, but recording that failed/);
  assert.equal(r1().status, "approved");
  assert.equal(resendMails().length, 1);
});

test("decide and adjust: when the Adjustments cannot be read, nothing is written and the route says so", async () => {
  db.missingTables = ["travel_reimbursement_adjustments"];
  db.signIn(MANAGER);
  assert.equal((await decide.POST(post({ action: "approve" }), ID)).status, 503);
  assert.equal((await adjust.POST(post(adjustment), ID)).status, 503);
  assert.equal(r1().status, "submitted");
  assert.equal(r1().parking_cents, 800);
  assert.equal(resendMails().length, 0);
});

test("another manager who is not an owner cannot approve, reject, send back or adjust a manager's; an owner can (ruling 28)", async () => {
  db.tables.travel_reimbursements = [row({ profile_id: MANAGER }), row({ id: 2, profile_id: MANAGER, status: "approved" })];
  db.signIn(MANAGER2);
  for (const body of [{ action: "approve" }, { action: "reject", reason: "Which store?" }]) {
    const res = await decide.POST(post(body), ID);
    assert.equal(res.status, 403, body.action);
    assert.match((await res.json()).error, /not another manager/, body.action);
  }
  assert.equal((await decide.POST(post({ action: "send_back" }), { params: { id: "2" } })).status, 403);
  assert.equal((await adjust.POST(post({ ...adjustment, evidence_path: "adjustments/1/9-e.png" }), ID)).status, 403);
  assert.deepEqual(db.rows("travel_reimbursements").map((r) => r.status), ["submitted", "approved"]);
  assert.equal(db.rows("travel_reimbursement_adjustments").length, 0);
  db.signIn(OWNER);
  assert.equal((await decide.POST(post({ action: "approve" }), ID)).status, 200);
  assert.equal(r1().decided_by, OWNER);
});

test("approve: no Mileage rate for the trip date, so no total: refused, and it stays Submitted (ruling 42)", async () => {
  db.tables.travel_reimbursements = [row({ trip_date: "2025-06-01" })];
  db.signIn(OWNER);
  const res = await decide.POST(post({ action: "approve" }), ID);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /no Mileage rate for 2025-06-01/);
  assert.equal(r1().status, "submitted");
  assert.equal(resendMails().length, 0);
  // Once the Mileage is adjusted it has a total and can be approved.
  db.tables.travel_reimbursements = [row({ trip_date: "2025-06-01", mileage_cents_override: 700 })];
  assert.equal((await decide.POST(post({ action: "approve" }), ID)).status, 200);
  assert.equal(r1().status, "approved");
});

test("reject: no Mileage rate for the trip date does not stop a rejection (ruling 42 refuses only approve)", async () => {
  db.tables.travel_reimbursements = [row({ trip_date: "2025-06-01" })];
  db.signIn(OWNER);
  const res = await decide.POST(post({ action: "reject", reason: "Which store?" }), ID);
  assert.equal(res.status, 200);
  assert.equal(r1().status, "rejected");
  assert.equal(r1().rejection_reason, "Which store?");
});

test("a manager who is not an owner cannot decide their own; an owner decides it, and an owner may decide their own", async () => {
  db.tables.travel_reimbursements = [row({ profile_id: MANAGER }), row({ id: 2, profile_id: OWNER, receipt_paths: [] , no_receipt_confirmed: true })];
  db.signIn(MANAGER);
  const own = await decide.POST(post({ action: "approve" }), ID);
  assert.equal(own.status, 403);
  assert.match((await own.json()).error, /owner decides it/);
  assert.equal(r1().status, "submitted");
  db.signIn(OWNER);
  assert.equal((await decide.POST(post({ action: "approve" }), ID)).status, 200);
  assert.equal((await decide.POST(post({ action: "approve" }), { params: { id: "2" } })).status, 200);
  assert.equal(db.rows("travel_reimbursements")[1].status, "approved");
});

test("staff cannot decide anything, not even their own", async () => {
  db.signIn(DONTE);
  assert.equal((await decide.POST(post({ action: "approve" }), ID)).status, 403);
  assert.equal(r1().status, "submitted");
});

// ---------- reject --------------------------------------------------------------------------

test("reject: needs a reason, and the employee is told it", async () => {
  db.signIn(MANAGER);
  assert.equal((await decide.POST(post({ action: "reject", reason: "  " }), ID)).status, 400);
  assert.equal(r1().status, "submitted");
  const res = await decide.POST(post({ action: "reject", reason: "Parking was free at Houston Hall." }), ID);
  assert.equal(res.status, 200);
  assert.equal(r1().status, "rejected");
  assert.equal(r1().rejection_reason, "Parking was free at Houston Hall.");
  const [n] = db.rows("notifications");
  assert.equal(n.user_id, DONTE);
  assert.equal(n.type, "reimbursement_decision");
  assert.equal(n.title, "Travel Reimbursement rejected");
  assert.match(String(n.body), /Parking was free at Houston Hall\./);
  assert.equal(resendMails().length, 0, "a rejected reimbursement's Receipts are not sent");
});

// ---------- send back, Paid outside payroll ----------------------------------------------------

test("send back: Approved returns to Submitted; Submitted and Paid cannot be sent back", async () => {
  db.tables.travel_reimbursements = [row({ status: "approved" }), row({ id: 2, status: "paid", paid_on: "2026-10-07" }), row({ id: 3 })];
  db.signIn(MANAGER);
  assert.equal((await decide.POST(post({ action: "send_back" }), ID)).status, 200);
  assert.equal(r1().status, "submitted");
  assert.equal((await decide.POST(post({ action: "send_back" }), { params: { id: "2" } })).status, 409);
  assert.equal((await decide.POST(post({ action: "send_back" }), { params: { id: "3" } })).status, 409);
  assert.equal(db.rows("travel_reimbursements")[1].status, "paid");
});

test("Paid outside payroll: an owner's Approved one, marked by an owner with today's date", async () => {
  db.tables.travel_reimbursements = [row({ profile_id: OWNER, status: "approved" }), row({ id: 2, status: "approved" })];
  db.signIn(MANAGER);
  assert.equal((await decide.POST(post({ action: "paid_outside_payroll" }), ID)).status, 409);
  db.signIn(OWNER2);
  assert.equal((await decide.POST(post({ action: "paid_outside_payroll" }), { params: { id: "2" } })).status, 409, "staff are paid on the paycheck");
  const res = await decide.POST(post({ action: "paid_outside_payroll" }), ID);
  assert.equal(res.status, 200);
  assert.equal(r1().status, "paid_outside_payroll");
  assert.equal(r1().paid_on, TODAY);
  assert.equal(r1().paid_by, OWNER2);
});

test("an unknown action is refused", async () => {
  db.signIn(MANAGER);
  assert.equal((await decide.POST(post({ action: "pay" }), ID)).status, 400);
});

// ---------- Adjustments ------------------------------------------------------------------------

const adjustment = { field: "parking", amount: "5.00", note: "Agreed on Slack: $5 lot", evidence_path: "adjustments/1/9-e.png" };

test("adjust: needs an evidence file and a one-line note", async () => {
  db.signIn(MANAGER);
  assert.equal((await adjust.POST(post({ ...adjustment, note: " " }), ID)).status, 400);
  assert.equal((await adjust.POST(post({ ...adjustment, evidence_path: "" }), ID)).status, 400);
  assert.equal((await adjust.POST(post({ ...adjustment, evidence_path: `${DONTE}/receipts/1-a.jpg` }), ID)).status, 400);
  assert.equal((await adjust.POST(post({ ...adjustment, evidence_path: "adjustments/2/x.png" }), ID)).status, 400, "evidence for another reimbursement");
  assert.equal((await adjust.POST(post({ ...adjustment, note: "x".repeat(301) }), ID)).status, 400);
  assert.equal(db.rows("travel_reimbursement_adjustments").length, 0);
});

test("adjust: evidence that was never uploaded is refused", async () => {
  db.signIn(MANAGER);
  const res = await adjust.POST(post({ ...adjustment, evidence_path: "adjustments/1/never-uploaded.png" }), ID);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /evidence/i);
  assert.equal(r1().parking_cents, 800);
  assert.equal(db.rows("travel_reimbursement_adjustments").length, 0);
});

test("adjust: a reimbursement decided meanwhile is refused and leaves no Adjustment behind", async () => {
  db.signIn(MANAGER);
  // Another Approver rejects it between this Approver's read and write.
  db.beforeWrite = () => {
    db.beforeWrite = null;
    Object.assign(r1(), { status: "rejected", rejection_reason: "Which store?", updated_at: "2026-10-08T15:00:00.000Z" });
  };
  const res = await adjust.POST(post(adjustment), ID);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /changed while you were looking/);
  assert.equal(r1().parking_cents, 800);
  assert.equal(db.rows("travel_reimbursement_adjustments").length, 0, "no Adjustment recorded for an amount that did not change");
  assert.equal(db.rows("notifications").length, 0);
});

test("adjust: the amount changes, the original is kept with the note, and the employee is told old and new", async () => {
  db.signIn(MANAGER);
  const res = await adjust.POST(post(adjustment), ID);
  assert.equal(res.status, 200);
  assert.equal(r1().parking_cents, 500);
  assert.equal(r1().status, "submitted", "an Adjustment does not decide it");
  const [a] = db.rows("travel_reimbursement_adjustments");
  assert.deepEqual(
    [a.reimbursement_id, a.field, a.old_cents, a.new_cents, a.note, a.evidence_path, a.adjusted_by],
    [1, "parking", 800, 500, "Agreed on Slack: $5 lot", "adjustments/1/9-e.png", MANAGER],
  );
  const [n] = db.rows("notifications");
  assert.equal(n.user_id, DONTE);
  assert.equal(n.title, "Travel Reimbursement adjusted");
  assert.match(String(n.body), /Parking changed from \$8\.00 to \$5\.00: Agreed on Slack: \$5 lot/);
});

test("adjust: the mileage amount replaces the computed one at the trip date's rate", async () => {
  db.signIn(MANAGER);
  // 10 mi on 2026-10-03 at 76c = $7.60
  const res = await adjust.POST(post({ ...adjustment, field: "mileage", amount: "7.00" }), ID);
  assert.equal(res.status, 200);
  assert.equal(r1().mileage_cents_override, 700);
  const [a] = db.rows("travel_reimbursement_adjustments");
  assert.equal(a.old_cents, 760);
  // Shown old -> new: $7.60 -> $7.00 (ruling 40).
  const { reimbursement } = await res.json();
  assert.deepEqual(reimbursement.before_adjustments.adjusted, ["mileage"]);
  assert.equal(reimbursement.before_adjustments.before.mileage_cents, 760);
  assert.equal(reimbursement.amounts.mileage_cents, 700);
});

test("adjust: an Approved one can be adjusted; Paid or Rejected cannot; nor a non-owner manager's own", async () => {
  db.tables.travel_reimbursements = [row({ status: "approved" }), row({ id: 2, status: "paid", paid_on: "2026-10-07" }), row({ id: 3, profile_id: MANAGER })];
  db.signIn(MANAGER);
  assert.equal((await adjust.POST(post(adjustment), ID)).status, 200);
  assert.equal((await adjust.POST(post({ ...adjustment, evidence_path: "adjustments/2/x.png" }), { params: { id: "2" } })).status, 409);
  assert.equal((await adjust.POST(post({ ...adjustment, evidence_path: "adjustments/3/x.png" }), { params: { id: "3" } })).status, 403);
});

test("Adjustment evidence is never emailed to receipts@", async () => {
  db.signIn(MANAGER);
  await adjust.POST(post(adjustment), ID);
  await decide.POST(post({ action: "approve" }), ID);
  const [mail] = resendMails();
  assert.deepEqual((mail.body.attachments as { filename: string }[]).map((f) => f.filename), ["1-a.jpg"]);
  assert.match(String(mail.body.text), /Parking: \$5\.00/);
});

test("evidence-url: an Approver uploads under adjustments/<id>/; staff cannot", async () => {
  db.signIn(MANAGER);
  const res = await evidenceUrl.POST(post({ reimbursement_id: 1, ext: "png", content_type: "image/png" }));
  assert.equal(res.status, 200);
  assert.match((await res.json()).path, /^adjustments\/1\/\d+-\w+\.png$/);
  db.signIn(DONTE);
  assert.equal((await evidenceUrl.POST(post({ reimbursement_id: 1, ext: "png", content_type: "image/png" }))).status, 403);
});

test("file: an Approver opens any reimbursement file on the finance site", async () => {
  db.signIn(MANAGER);
  const res = await financeFile.GET(new Request(`http://finance.test/api/payroll/reimbursements/file?path=${DONTE}/receipts/1-a.jpg`));
  assert.equal(res.status, 307);
});
