// The life of a Travel Reimbursement and who may decide one (bj-finance #210,
// rulings 10, 18-20, 23, 28): Submitted -> Approved | Rejected -> Paid, or
// Paid outside payroll for an owner; staff change their own only while
// Submitted or Rejected; an Approver may send an Approved one back until it is
// Paid; Paid is final. Approvers are managers and owners; an owner may decide
// their own, and a manager who is not an owner has theirs decided by an owner
// only, never by themselves or another manager.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  approverAction,
  approversToNotify,
  isApprover,
  isOwner,
  mayDecide,
  payrollMayMarkPaid,
  staffMayChange,
  STATUS_LABEL,
} from "./lifecycle.ts";

const OWNER = { id: "alina", role: "manager", active: false };
const OWNER2 = { id: "alex", role: "manager", active: false };
const MANAGER = { id: "sophia", role: "manager", active: true };
const MANAGER2 = { id: "mira", role: "manager", active: true };
const STAFF = { id: "donte", role: "employee", active: true };
const OFFICE = { id: "office", role: "employee", active: false };

test("owners are managers kept off the roster; Approvers are managers and owners", () => {
  assert.equal(isOwner(OWNER), true);
  assert.equal(isOwner(MANAGER), false);
  assert.equal(isOwner(OFFICE), false, "an inactive employee is not an owner");
  assert.equal(isApprover(OWNER), true);
  assert.equal(isApprover(MANAGER), true);
  assert.equal(isApprover(STAFF), false);
});

test("mayDecide: an Approver decides a staff member's reimbursement", () => {
  assert.equal(mayDecide(MANAGER, STAFF), null);
  assert.equal(mayDecide(OWNER, STAFF), null);
});

test("mayDecide: an owner may decide their own", () => {
  assert.equal(mayDecide(OWNER, OWNER), null);
  assert.equal(mayDecide(OWNER2, OWNER), null);
});

test("mayDecide: a manager who is not an owner may not decide their own; an owner decides it", () => {
  assert.match(mayDecide(MANAGER, MANAGER) ?? "", /cannot decide their own/);
  assert.equal(mayDecide(OWNER, MANAGER), null);
});

test("mayDecide: a non-owner manager's reimbursement is decided only by an owner, never another manager (ruling 28)", () => {
  assert.match(mayDecide(MANAGER2, MANAGER) ?? "", /not another manager/);
  assert.match(mayDecide(MANAGER, MANAGER2) ?? "", /not another manager/);
  assert.equal(mayDecide(OWNER, MANAGER), null);
  assert.equal(mayDecide(OWNER2, MANAGER2), null);
  for (const action of ["approve", "reject", "adjust"] as const) {
    const r = approverAction(action, "submitted", { subject: MANAGER, actor: MANAGER2 });
    assert.equal(r.ok, false, action);
    assert.equal(r.ok === false && r.forbidden, true, action);
    assert.equal(approverAction(action, "submitted", { subject: MANAGER, actor: OWNER }).ok, true, action);
  }
  assert.equal(approverAction("send_back", "approved", { subject: MANAGER, actor: MANAGER2 }).ok, false);
  assert.equal(approverAction("send_back", "approved", { subject: MANAGER, actor: OWNER }).ok, true);
});

test("mayDecide: any manager or owner still decides an employee's", () => {
  assert.equal(mayDecide(MANAGER2, STAFF), null);
  assert.equal(approverAction("approve", "submitted", { subject: STAFF, actor: MANAGER2 }).ok, true);
  assert.equal(approverAction("approve", "submitted", { subject: STAFF, actor: OWNER }).ok, true);
});

test("mayDecide: an owner's reimbursement is unchanged: another owner or a manager decides it", () => {
  assert.equal(mayDecide(MANAGER, OWNER), null);
  assert.equal(mayDecide(OWNER2, OWNER), null);
});

test("mayDecide: staff decide nothing, not even their own", () => {
  assert.match(mayDecide(STAFF, STAFF) ?? "", /Approver/);
  assert.match(mayDecide(STAFF, OWNER) ?? "", /Approver/);
});

test("approve and reject only a Submitted reimbursement", () => {
  assert.deepEqual(approverAction("approve", "submitted", { subject: STAFF, actor: MANAGER }), { ok: true, to: "approved" });
  assert.deepEqual(approverAction("reject", "submitted", { subject: STAFF, actor: MANAGER }), { ok: true, to: "rejected" });
  for (const from of ["approved", "rejected", "paid", "paid_outside_payroll"] as const) {
    assert.equal(approverAction("approve", from, { subject: STAFF, actor: MANAGER }).ok, false, `approve from ${from}`);
    assert.equal(approverAction("reject", from, { subject: STAFF, actor: MANAGER }).ok, false, `reject from ${from}`);
  }
});

test("send back: an Approved reimbursement returns to Submitted until it is Paid", () => {
  assert.deepEqual(approverAction("send_back", "approved", { subject: STAFF, actor: MANAGER }), { ok: true, to: "submitted" });
  for (const from of ["submitted", "rejected", "paid", "paid_outside_payroll"] as const) {
    assert.equal(approverAction("send_back", from, { subject: STAFF, actor: MANAGER }).ok, false, `send back from ${from}`);
  }
});

test("Paid outside payroll: an owner's Approved reimbursement, marked by an owner", () => {
  assert.deepEqual(approverAction("paid_outside_payroll", "approved", { subject: OWNER, actor: OWNER2 }), { ok: true, to: "paid_outside_payroll" });
  assert.deepEqual(approverAction("paid_outside_payroll", "approved", { subject: OWNER, actor: OWNER }), { ok: true, to: "paid_outside_payroll" });
  assert.equal(approverAction("paid_outside_payroll", "approved", { subject: OWNER, actor: MANAGER }).ok, false, "a manager is not an owner");
  assert.equal(approverAction("paid_outside_payroll", "approved", { subject: STAFF, actor: OWNER }).ok, false, "staff are paid through payroll");
  assert.equal(approverAction("paid_outside_payroll", "submitted", { subject: OWNER, actor: OWNER }).ok, false);
});

test("an Adjustment is made while Submitted or Approved, never after Paid or on a Rejected one", () => {
  assert.equal(approverAction("adjust", "submitted", { subject: STAFF, actor: MANAGER }).ok, true);
  assert.equal(approverAction("adjust", "approved", { subject: STAFF, actor: MANAGER }).ok, true);
  for (const from of ["rejected", "paid", "paid_outside_payroll"] as const) {
    assert.equal(approverAction("adjust", from, { subject: STAFF, actor: MANAGER }).ok, false, `adjust from ${from}`);
  }
});

test("every Approver action is refused to someone who may not decide the reimbursement", () => {
  for (const action of ["approve", "reject", "adjust"] as const) {
    const r = approverAction(action, "submitted", { subject: MANAGER, actor: MANAGER });
    assert.equal(r.ok, false, action);
  }
  assert.equal(approverAction("send_back", "approved", { subject: MANAGER, actor: MANAGER }).ok, false);
});

test("staff change (edit, resubmit, delete) their own only while Submitted or Rejected", () => {
  assert.equal(staffMayChange("submitted"), true);
  assert.equal(staffMayChange("rejected"), true);
  assert.equal(staffMayChange("approved"), false);
  assert.equal(staffMayChange("paid"), false);
  assert.equal(staffMayChange("paid_outside_payroll"), false);
});

test("payroll marks Paid only an Approved reimbursement of payroll staff, never an owner's", () => {
  assert.equal(payrollMayMarkPaid("approved", STAFF), true);
  assert.equal(payrollMayMarkPaid("approved", MANAGER), true);
  assert.equal(payrollMayMarkPaid("approved", OWNER), false);
  assert.equal(payrollMayMarkPaid("submitted", STAFF), false);
  assert.equal(payrollMayMarkPaid("paid", STAFF), false);
});

test("on submit, notify every Approver who may decide it, except the person who submitted", () => {
  const approvers = [OWNER, OWNER2, MANAGER, MANAGER2];
  assert.deepEqual(approversToNotify(approvers, STAFF).map((a) => a.id), ["alina", "alex", "sophia", "mira"]);
  assert.deepEqual(approversToNotify(approvers, MANAGER).map((a) => a.id), ["alina", "alex"], "a manager's: owners only");
  assert.deepEqual(approversToNotify(approvers, OWNER).map((a) => a.id), ["alex", "sophia", "mira"]);
});

test("status labels are the glossary's words", () => {
  assert.deepEqual(STATUS_LABEL, {
    submitted: "Submitted",
    approved: "Approved",
    rejected: "Rejected",
    paid: "Paid",
    paid_outside_payroll: "Paid outside payroll",
  });
});
