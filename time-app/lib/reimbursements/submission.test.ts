// What a staff member sends to submit or edit a Travel Reimbursement, or to
// file a Lyft ride report, checked before anything is written (bj-finance
// #210, rulings 3-5, 7-9, 12, 14).
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIRM_NO_RECEIPT, contentTypeOf, extOf, parseLyftRideReport, parseReimbursement, uploadPath } from "./submission.ts";

const ME = "11111111-1111-1111-1111-111111111111";
const TODAY = "2026-10-08";
const ctx = { profileId: ME, today: TODAY };

const typed = {
  reason: { kind: "errands", note: "Restaurant Depot, cones" },
  trip_date: "2026-10-06",
  mileage: { mode: "typed", miles: "12.3" },
};

test("typed miles for errands, with the note", () => {
  const r = parseReimbursement(typed, ctx);
  assert.deepEqual(r, {
    ok: true,
    value: {
      reason_kind: "errands",
      event_id: null,
      reason_note: "Restaurant Depot, cones",
      trip_date: "2026-10-06",
      mileage_mode: "typed",
      miles: 12.3,
      stops: null,
      start_at_store: null,
      end_at_store: null,
      tolls_cents: 0,
      parking_cents: 0,
      receipt_paths: [],
      no_receipt_confirmed: false,
    },
  });
});

test("Groceries / errands needs a 'what for / where' note; a Catering Event does not", () => {
  const r = parseReimbursement({ ...typed, reason: { kind: "errands", note: "  " } }, ctx);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /what for/i);
  const c = parseReimbursement({ ...typed, reason: { kind: "catering_event", event_id: 77 } }, ctx);
  assert.equal(c.ok && c.value.event_id, 77);
  assert.equal(c.ok && c.value.reason_note, null);
});

test("a Reason is required: a Catering Event needs one picked", () => {
  assert.equal(parseReimbursement({ ...typed, reason: undefined }, ctx).ok, false);
  assert.equal(parseReimbursement({ ...typed, reason: { kind: "catering_event" } }, ctx).ok, false);
  assert.equal(parseReimbursement({ ...typed, reason: { kind: "lunch" } }, ctx).ok, false);
});

test("the trip date is a real day, not in the future", () => {
  assert.equal(parseReimbursement({ ...typed, trip_date: "2026-10-09" }, ctx).ok, false);
  assert.equal(parseReimbursement({ ...typed, trip_date: "10/06/2026" }, ctx).ok, false);
  assert.equal(parseReimbursement({ ...typed, trip_date: "2026-10-08" }, ctx).ok, true);
  // No pay-period limit: months later is fine (ruling 11).
  assert.equal(parseReimbursement({ ...typed, trip_date: "2026-03-02" }, ctx).ok, true);
});

test("destinations mode: stops, with Start and End at the store each on unless turned off", () => {
  const on = parseReimbursement({ ...typed, mileage: { mode: "destinations", stops: [" Venue ", ""] } }, ctx);
  assert.equal(on.ok && on.value.mileage_mode, "destinations");
  assert.deepEqual(on.ok && on.value.stops, ["Venue"]);
  assert.equal(on.ok && on.value.start_at_store, true);
  assert.equal(on.ok && on.value.end_at_store, true);
  assert.equal(on.ok && on.value.miles, null, "the server computes the miles");
  const noEnd = parseReimbursement({ ...typed, mileage: { mode: "destinations", stops: ["Venue"], end_at_store: false } }, ctx);
  assert.equal(noEnd.ok && noEnd.value.end_at_store, false);
  assert.equal(noEnd.ok && noEnd.value.start_at_store, true);
  const noStart = parseReimbursement({ ...typed, mileage: { mode: "destinations", stops: ["Restaurant Depot"], start_at_store: false } }, ctx);
  assert.equal(noStart.ok && noStart.value.start_at_store, false);
  assert.equal(noStart.ok && noStart.value.end_at_store, true);
  assert.equal(parseReimbursement({ ...typed, mileage: { mode: "destinations", stops: [] } }, ctx).ok, false);
});

test("destinations mode: with neither end at the store, two stops at least", () => {
  const one = parseReimbursement({ ...typed, mileage: { mode: "destinations", stops: ["A"], start_at_store: false, end_at_store: false } }, ctx);
  assert.equal(one.ok, false);
  const two = parseReimbursement({ ...typed, mileage: { mode: "destinations", stops: ["A", "B"], start_at_store: false, end_at_store: false } }, ctx);
  assert.equal(two.ok, true);
});

test("tolls and parking are optional amounts on any Reason", () => {
  const r = parseReimbursement({ ...typed, tolls: "4.50", parking: "$12", receipt_paths: [`${ME}/receipts/a.jpg`] }, ctx);
  assert.equal(r.ok && r.value.tolls_cents, 450);
  assert.equal(r.ok && r.value.parking_cents, 1200);
  assert.equal(parseReimbursement({ ...typed, tolls: "-1" }, ctx).ok, false);
});

test("tolls or parking with no Receipt asks 'Are you sure there is no receipt?' until confirmed", () => {
  const ask = parseReimbursement({ ...typed, parking: "10" }, ctx);
  assert.deepEqual(ask, { ok: false, error: CONFIRM_NO_RECEIPT, confirm: "no_receipt" });
  assert.equal(CONFIRM_NO_RECEIPT, "Are you sure there is no receipt?");
  const yes = parseReimbursement({ ...typed, parking: "10", no_receipt_confirmed: true }, ctx);
  assert.equal(yes.ok && yes.value.no_receipt_confirmed, true);
});

test("nothing to pay is refused: no miles, tolls or parking", () => {
  const r = parseReimbursement({ ...typed, mileage: { mode: "typed", miles: "0" } }, ctx);
  assert.equal(r.ok, false);
  assert.equal(parseReimbursement({ ...typed, mileage: { mode: "typed", miles: "0" }, tolls: "2", no_receipt_confirmed: true }, ctx).ok, true);
});

test("Receipts must be the staff member's own uploads", () => {
  assert.equal(parseReimbursement({ ...typed, receipt_paths: ["someone-else/receipts/a.jpg"] }, ctx).ok, false);
  assert.equal(parseReimbursement({ ...typed, receipt_paths: [`${ME}/lyft/a.jpg`] }, ctx).ok, false);
  assert.equal(parseReimbursement({ ...typed, receipt_paths: [`${ME}/receipts/../x.jpg`] }, ctx).ok, false);
  assert.equal(parseReimbursement({ ...typed, receipt_paths: [`${ME}/receipts/a.jpg`] }, ctx).ok, true);
});

test("a Lyft ride report: a Reason, a trip date and at least one screenshot of the staff member's own", () => {
  const r = parseLyftRideReport({ reason: { kind: "catering_event", event_id: 5 }, trip_date: "2026-10-03", screenshot_paths: [`${ME}/lyft/1.png`] }, ctx);
  assert.deepEqual(r, {
    ok: true,
    value: { reason_kind: "catering_event", event_id: 5, reason_note: null, trip_date: "2026-10-03", screenshot_paths: [`${ME}/lyft/1.png`] },
  });
  assert.equal(parseLyftRideReport({ reason: { kind: "catering_event", event_id: 5 }, trip_date: "2026-10-03", screenshot_paths: [] }, ctx).ok, false);
  assert.equal(parseLyftRideReport({ reason: { kind: "catering_event", event_id: 5 }, trip_date: "2026-10-03", screenshot_paths: [`${ME}/receipts/1.png`] }, ctx).ok, false);
});

test("uploadPath: under the staff member's own folder, by kind, with a safe extension", () => {
  const p = uploadPath({ folder: ME, kind: "receipts", ext: "JPG", content_type: "image/jpeg" }, () => "abc");
  assert.equal(p.ok && p.path.startsWith(`${ME}/receipts/`), true);
  assert.equal(p.ok && p.path.endsWith("-abc.jpg"), true);
  assert.equal(uploadPath({ folder: ME, kind: "lyft", ext: "pdf", content_type: "application/pdf" }, () => "x").ok, true);
  assert.equal(uploadPath({ folder: ME, kind: "receipts", ext: "exe", content_type: "application/octet-stream" }, () => "x").ok, false);
  assert.equal(uploadPath({ folder: ME, kind: "receipts", ext: "jpg", content_type: "text/html" }, () => "x").ok, false);
});

test("a picked file's type: the browser's, else its extension's, else none", () => {
  assert.equal(extOf("IMG_0042.HEIC"), "heic");
  assert.equal(extOf("receipt.scan.pdf"), "pdf");
  assert.equal(contentTypeOf("IMG_0042.HEIC"), "image/heic");
  assert.equal(contentTypeOf("IMG_0042.HEIC", "image/jpeg"), "image/jpeg");
  assert.equal(contentTypeOf("u1/receipts/1-ab.pdf"), "application/pdf");
  assert.equal(contentTypeOf("notes.txt"), "");
  assert.equal(contentTypeOf("noextension"), "");
});
