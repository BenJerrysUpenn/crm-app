// The life of a Travel Reimbursement, and who may decide one (bj-finance #210).
//
//   Submitted -> Approved | Rejected            an Approver decides (ruling 10)
//   Rejected  -> Submitted                      the staff member edits and resubmits
//   Approved  -> Submitted                      an Approver sends it back, until Paid (20)
//   Approved  -> Paid                           payroll, when the submittal is approved (22)
//   Approved  -> Paid outside payroll           an owner's own, marked by an owner (18)
//   Paid, Paid outside payroll                  final
//
// Staff edit or delete their own only while Submitted or Rejected (20).
// Approvers are managers and owners (10). An owner may decide their own (19).
// A manager who is not an owner may not decide their own, and neither may
// another such manager: only an owner decides it (28). An employee's is
// decided by any Approver.
//
// Owners, today, are managers kept off the roster: role 'manager' with
// active = false (lib/financeAccess.ts). This is the one place that says so
// for reimbursements; migration 37's guard trigger holds the database to it.
//
// A Lyft ride report is not in here: it is Filed on upload and has no life.
//
// Pure and dependency-free, so `node --test` runs it and the browser can use it.

export type ReimbursementStatus = "submitted" | "approved" | "rejected" | "paid" | "paid_outside_payroll";

export const STATUS_LABEL: Record<ReimbursementStatus, string> = {
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  paid: "Paid",
  paid_outside_payroll: "Paid outside payroll",
};

export type Person = { id: string; role: string; active: boolean };

/** An owner: a manager kept off the roster (lib/financeAccess.ts). */
export function isOwner(p: Pick<Person, "role" | "active">): boolean {
  return p.role === "manager" && p.active === false;
}

/** An Approver: a manager or an owner (the same gate as the finance site). */
export function isApprover(p: Pick<Person, "role">): boolean {
  return p.role === "manager";
}

export const NOT_APPROVER = "Only an Approver (a manager or owner) can do that.";
export const NOT_OWN = "A manager cannot decide their own Travel Reimbursement; an owner decides it.";
export const NOT_MANAGERS = "A manager's Travel Reimbursement is decided by an owner, not another manager.";

/** Why `actor` may not decide `subject`'s reimbursement, or null when they may. */
export function mayDecide(actor: Person, subject: Person): string | null {
  if (!isApprover(actor)) return NOT_APPROVER;
  if (isApprover(subject) && !isOwner(subject) && !isOwner(actor)) {
    return actor.id === subject.id ? NOT_OWN : NOT_MANAGERS;
  }
  return null;
}

/** May the staff member who submitted it edit, resubmit or delete it? */
export function staffMayChange(status: ReimbursementStatus): boolean {
  return status === "submitted" || status === "rejected";
}

/** The amounts an Adjustment can change, as the Approver and the employee see them. */
export type AdjustmentField = "mileage" | "tolls" | "parking";

export const FIELD_LABEL: Record<AdjustmentField, string> = { mileage: "Mileage", tolls: "Tolls", parking: "Parking" };

export type ApproverAction = "approve" | "reject" | "send_back" | "paid_outside_payroll" | "adjust";

/** `forbidden`: this person may not decide this reimbursement at all (403), rather than not now (409). */
export type ActionResult = { ok: true; to: ReimbursementStatus } | { ok: false; error: string; forbidden: boolean };

const FROM: Record<ApproverAction, ReimbursementStatus[]> = {
  approve: ["submitted"],
  reject: ["submitted"],
  send_back: ["approved"],
  paid_outside_payroll: ["approved"],
  adjust: ["submitted", "approved"],
};

const TO: Record<Exclude<ApproverAction, "adjust">, ReimbursementStatus> = {
  approve: "approved",
  reject: "rejected",
  send_back: "submitted",
  paid_outside_payroll: "paid_outside_payroll",
};

const NOT_FROM: Record<ApproverAction, string> = {
  approve: "Only a Submitted Travel Reimbursement can be approved.",
  reject: "Only a Submitted Travel Reimbursement can be rejected.",
  send_back: "Only an Approved Travel Reimbursement can be sent back, and only until it is Paid.",
  paid_outside_payroll: "Only an Approved Travel Reimbursement can be marked Paid outside payroll.",
  adjust: "An Adjustment can only be made while a Travel Reimbursement is Submitted or Approved.",
};

/**
 * What an Approver's action does to a reimbursement in `from`, or why it is
 * refused. An Adjustment leaves the status where it is.
 */
export function approverAction(
  action: ApproverAction,
  from: ReimbursementStatus,
  who: { subject: Person; actor: Person },
): ActionResult {
  const refused = mayDecide(who.actor, who.subject);
  if (refused) return { ok: false, error: refused, forbidden: true };
  if (!FROM[action].includes(from)) return { ok: false, error: NOT_FROM[action], forbidden: false };
  if (action === "paid_outside_payroll") {
    if (!isOwner(who.subject))
      return { ok: false, error: "Only an owner's Travel Reimbursement is paid outside payroll; staff are paid on the paycheck.", forbidden: false };
    if (!isOwner(who.actor)) return { ok: false, error: "Only an owner can mark a Travel Reimbursement Paid outside payroll.", forbidden: false };
  }
  return { ok: true, to: action === "adjust" ? from : TO[action] };
}

/**
 * The statuses that take a reimbursement off the Approver's queue. They are
 * listed under Decided at the bottom of the tab, not out of sight (ruling 41).
 * Approved stays on the queue until it is Paid.
 */
export const LEFT_QUEUE: ReimbursementStatus[] = ["rejected", "paid", "paid_outside_payroll"];

/** How many of the latest Decided items the tab lists. */
export const DECIDED_SHOWN = 50;

export type DecisionFields = {
  status: ReimbursementStatus;
  decided_by: string | null;
  decided_at: string | null;
  paid_by: string | null;
  paid_on: string | null;
  rejection_reason: string | null;
};

/**
 * Who took it off the queue, and when: Rejected by an Approver (with the
 * reason); Paid outside payroll by an owner on the date paid; Paid by payroll
 * (no one person) on the pay date.
 */
export function decisionOf(r: DecisionFields): { by: string | null; at: string | null; reason: string | null } {
  if (r.status === "rejected") return { by: r.decided_by, at: r.decided_at, reason: r.rejection_reason };
  if (r.status === "paid_outside_payroll") return { by: r.paid_by, at: r.paid_on, reason: null };
  return { by: null, at: r.paid_on, reason: null };
}

/** May payroll mark this reimbursement Paid? Approved, and not an owner's (18, 22). */
export function payrollMayMarkPaid(status: ReimbursementStatus, subject: Person): boolean {
  return status === "approved" && !isOwner(subject);
}

/** Who hears of a new submission: every Approver who may decide it, but not its submitter. */
export function approversToNotify<T extends Person>(approvers: T[], subject: Person): T[] {
  return approvers.filter((a) => a.id !== subject.id && mayDecide(a, subject) === null);
}
