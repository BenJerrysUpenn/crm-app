// What Withers Time sends to receipts@withers-ventures.com (bj-finance #210).
//
//   * Lyft ride reports: on upload (ruling 23). The ride was charged to the
//     company card, so the receipt processor files it as an ordinary Lyft
//     vendor receipt and matches it to the card charge.
//   * Toll and parking Receipts of a Travel Reimbursement: when it is
//     Approved (ruling 30). Paid on the staff member's own card, so the
//     processor files them "reimbursed via payroll" and never bank-matches
//     them (crm-app docs/adr/0001).
//   * Adjustment evidence: never (ruling 36).
//
// THE FORMAT IS A CONTRACT with bj-finance's receipt processor. It recognises
// these by the fixed From (NOTIFICATIONS_FROM_EMAIL), the subject prefix
// "[Withers Time]", and the kind straight after it: "Travel Reimbursement
// receipt" or "Lyft ride report". The body is "Key: value" lines, then a blank
// line and one sentence for a human. Change it only together with the processor.
//
// Pure, so `node --test` runs it.

import { money } from "../payroll/paySheet.ts";

export const RECEIPTS_TO = "receipts@withers-ventures.com";
export const SUBJECT_PREFIX = "[Withers Time]";
export const KIND_RECEIPT = "Travel Reimbursement receipt";
export const KIND_LYFT = "Lyft ride report";

export type Mail = { subject: string; text: string };

export function travelReimbursementReceiptEmail(r: {
  id: number;
  employee: string;
  reason: string;
  trip_date: string;
  tolls_cents: number;
  parking_cents: number;
  total_cents: number | null;
  attachments: number;
}): Mail {
  const receipted = r.tolls_cents + r.parking_cents;
  return {
    subject: `${SUBJECT_PREFIX} ${KIND_RECEIPT}: ${r.employee}, ${r.trip_date}, ${money(receipted)}`,
    text: [
      `Kind: ${KIND_RECEIPT}`,
      `Employee: ${r.employee}`,
      `Reason: ${r.reason}`,
      `Trip date: ${r.trip_date}`,
      `Tolls: ${money(r.tolls_cents)}`,
      `Parking: ${money(r.parking_cents)}`,
      `Amount: ${money(receipted)}`,
      `Travel Reimbursement total: ${money(r.total_cents)}`,
      `Travel Reimbursement ID: ${r.id}`,
      `Attachments: ${r.attachments}`,
      "",
      "Approved in Withers Time. Paid on the employee's own card and reimbursed via payroll: never match this receipt to a bank or card line (crm-app docs/adr/0001).",
    ].join("\n"),
  };
}

export function lyftRideReportEmail(r: { id: number; employee: string; reason: string; trip_date: string; attachments: number }): Mail {
  return {
    subject: `${SUBJECT_PREFIX} ${KIND_LYFT}: ${r.employee}, ${r.trip_date}`,
    text: [
      `Kind: ${KIND_LYFT}`,
      `Employee: ${r.employee}`,
      `Reason: ${r.reason}`,
      `Trip date: ${r.trip_date}`,
      "Amount: none reimbursed",
      `Lyft ride report ID: ${r.id}`,
      `Attachments: ${r.attachments}`,
      "",
      "Filed in Withers Time. The ride was charged to the company card on Lyft: match it to that card charge like any Lyft receipt.",
    ].join("\n"),
  };
}
