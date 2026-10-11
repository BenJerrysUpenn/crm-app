// The emails Withers Time sends to receipts@withers-ventures.com (bj-finance
// #210, rulings 15, 23, 30, 36; crm-app ADR 0001). bj-finance's receipt
// processor tells them apart by the subject's "[Withers Time]" prefix and the
// kind that follows it, and reads the "Key: value" lines of the body. This
// format is a contract: change it only with the processor.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { RECEIPTS_TO, lyftRideReportEmail, travelReimbursementReceiptEmail } from "./receiptsEmail.ts";

test("receipts go to receipts@withers-ventures.com", () => {
  assert.equal(RECEIPTS_TO, "receipts@withers-ventures.com");
});

test("a Travel Reimbursement receipt email names the kind, employee, Reason, trip date and amounts", () => {
  const mail = travelReimbursementReceiptEmail({
    id: 42,
    employee: "Donte Smith",
    reason: "Catering Event: Sat Oct 3, 2026, 2:00 PM, Acme at Houston Hall, 3417 Spruce St",
    trip_date: "2026-10-03",
    tolls_cents: 450,
    parking_cents: 800,
    total_cents: 2010,
    attachments: 2,
  });
  assert.equal(mail.subject, "[Withers Time] Travel Reimbursement receipt: Donte Smith, 2026-10-03, $12.50");
  assert.equal(
    mail.text,
    [
      "Kind: Travel Reimbursement receipt",
      "Employee: Donte Smith",
      "Reason: Catering Event: Sat Oct 3, 2026, 2:00 PM, Acme at Houston Hall, 3417 Spruce St",
      "Trip date: 2026-10-03",
      "Tolls: $4.50",
      "Parking: $8.00",
      "Amount: $12.50",
      "Travel Reimbursement total: $20.10",
      "Travel Reimbursement ID: 42",
      "Attachments: 2",
      "",
      "Approved in Withers Time. Paid on the employee's own card and reimbursed via payroll: never match this receipt to a bank or card line (crm-app docs/adr/0001).",
    ].join("\n"),
  );
});

test("a Lyft ride report email says nothing is reimbursed and to match the company card", () => {
  const mail = lyftRideReportEmail({
    id: 7,
    employee: "Donte Smith",
    reason: "Groceries / errands: Restaurant Depot",
    trip_date: "2026-10-05",
    attachments: 1,
  });
  assert.equal(mail.subject, "[Withers Time] Lyft ride report: Donte Smith, 2026-10-05");
  assert.equal(
    mail.text,
    [
      "Kind: Lyft ride report",
      "Employee: Donte Smith",
      "Reason: Groceries / errands: Restaurant Depot",
      "Trip date: 2026-10-05",
      "Amount: none reimbursed",
      "Lyft ride report ID: 7",
      "Attachments: 1",
      "",
      "Filed in Withers Time. The ride was charged to the company card on Lyft: match it to that card charge like any Lyft receipt.",
    ].join("\n"),
  );
});
