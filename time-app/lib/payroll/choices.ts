// Per-case payroll choices and the one run approval (bj-finance #519, ruled
// 2026-09-22). Pure and dependency-free so `node --test` runs it, and the
// rulings route, the approve route and the UI all apply the same rules.

import { RULING_CHOICES, choicePays, type ApprovalRow, type Finding, type VerifyResult } from "./verify.ts";
import { firstApprovalDay, periodEnded } from "./window.ts";

/** A payee as the route found it in `profiles`, or null if the id is unknown. */
export type PayeeProfile = { id: string; role: string | null; active: boolean } | null;

/**
 * Is this (check, choice, payee) a choice the database may hold?
 *
 * Returns an error message, or null when it is fine. A paying choice must name
 * somebody who exists and is active; "pay unpunched manager" must name a
 * manager; every other choice must name nobody, so a stale payee can never
 * ride along on a skip.
 */
export function validateChoice(check: string, choice: string, payeeId: string | null, payee: PayeeProfile): string | null {
  const allowed = RULING_CHOICES[check];
  if (check === "1.4" || check === "1.5")
    return `${check} has no default and no choice (ruled 2026-09-22). Correct the punch on the Timesheets page instead.`;
  if (!allowed) return `${check || "That check"} is decided by rule, not by a choice.`;
  if (!allowed.includes(choice)) return `${choice || "That choice"} is not one of the options for check ${check}.`;
  if (!choicePays(check, choice)) {
    return payeeId ? `${choice} pays nobody, so it cannot name a person.` : null;
  }
  if (!payeeId) return "Pick the person this pays.";
  if (!payee || !payee.active) return "That person is not an active team member.";
  if (choice === "unpunched_manager" && payee.role !== "manager") return "Pick a manager: this pays a manager who closed without punching.";
  return null;
}

/** One case as it stood when the run was approved. Stored on the approval. */
export type SnapshotEntry = {
  key: string;
  check: string;
  choice: string;
  payee_id: string | null;
  payee_name: string | null;
  source: "recorded" | "default";
};

/** Every case with an effective choice, for the approval's record. */
export function approvalSnapshot(findings: Finding[]): SnapshotEntry[] {
  return findings
    .filter((f) => f.status === "needs_ruling")
    .map((f) => {
      const effective = f.effective ?? (f.ruling ? { choice: f.ruling.choice, payee: null, source: "recorded" as const } : null);
      return {
        key: f.key,
        check: f.check,
        choice: effective?.choice ?? "",
        payee_id: effective?.payee?.id ?? f.ruling?.payee_id ?? null,
        payee_name: effective?.payee?.name ?? null,
        source: effective?.source ?? "recorded",
      };
    });
}

/**
 * Why this run cannot be approved, or null when it can.
 *
 * "Any manager can approve" (ruled 2026-09-22): the only conditions are the
 * data's and the calendar's, never who is asking. Approval is FINAL — it
 * starts payroll — so a run is approved once, only after its period has
 * ended, and never over a run that shares its days. Migration 27's trigger
 * refuses the same things in the database.
 */
export function approvalBlocker(
  result: Pick<VerifyResult, "ready" | "counts" | "window" | "approval"> & { findings?: Finding[] },
  approvalsReady: boolean,
  today: string,
  otherApprovals: Pick<ApprovalRow, "window_end">[] = [],
): string | null {
  if (!approvalsReady) return "Approvals need migration 27. Run it in Supabase first.";
  if (result.approval) return "This pay run is already approved. Approval is final.";
  if (!periodEnded(result.window, today))
    return `The pay period ends ${result.window.end}. It can be approved from ${firstApprovalDay(result.window)}.`;
  const overlap = otherApprovals.find((a) => a.window_end);
  if (overlap) return `The pay run ending ${overlap.window_end} is already approved and shares days with this one.`;
  const punches = punchesToCorrect(result.findings ?? []);
  if (punches.length > 0)
    return `Correct ${punches.length === 1 ? "this punch" : `these ${punches.length} punches`} on the Timesheets page first. They have no default (ruled 2026-09-22): ${punches.map(describePunchFix).join("; ")}.`;
  if (result.counts.needsFix > 0) return `${result.counts.needsFix} finding(s) must be fixed in the app first.`;
  if (!result.ready) return "Some cases still need a choice: their default names nobody to pay.";
  return null;
}

/**
 * §1.4 (a runaway punch with no scheduled shift) and §1.5 (a punch under 25%
 * of its scheduled shift). Ruling D, 2026-09-22: no default and no picker —
 * each is corrected upstream, and the run is blocked until every one is.
 */
export function punchesToCorrect(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.status === "needs_fix" && (f.check === "1.4" || f.check === "1.5"));
}

function describePunchFix(f: Finding): string {
  const what = f.check === "1.4" ? "runaway, no shift" : "short punch";
  const punch = f.evidence.punch_ids?.[0];
  const who = [f.evidence.employee_name ?? "someone", f.evidence.date].filter(Boolean).join(" ");
  return `${f.check} ${what}: ${who}${punch ? ` (punch ${punch})` : ""}`;
}

/** "Approving this run would pay you": the §3.5/§3.7 flag, before it happens. */
export function paysApprover(findings: Finding[], approverId: string): Finding[] {
  return findings.filter(
    (f) => (f.check === "3.5" || f.check === "3.7") && f.effective?.payee?.id === approverId,
  );
}
