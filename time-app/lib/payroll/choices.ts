// Per-case payroll choices and the one run approval (bj-finance #519, ruled
// 2026-09-22). Pure and dependency-free so `node --test` runs it, and the
// rulings route, the approve route and the UI all apply the same rules.

import { RULING_CHOICES, choicePays, type Finding, type VerifyResult } from "./verify.ts";

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
 * Why this run cannot be approved yet, or null when it can.
 *
 * "Any manager can approve" (ruled 2026-09-22): the only conditions are the
 * data's, never who is asking.
 */
export function approvalBlocker(result: Pick<VerifyResult, "ready" | "counts">, approvalsReady: boolean): string | null {
  if (!approvalsReady) return "Approvals need migration 27. Run it in Supabase first.";
  if (result.counts.needsFix > 0) return `${result.counts.needsFix} finding(s) must be fixed in the app first.`;
  if (!result.ready) return "Some cases have no default and still need a choice.";
  return null;
}

/** "Approving this run would pay you": the §3.5/§3.7 flag, before it happens. */
export function paysApprover(findings: Finding[], approverId: string): Finding[] {
  return findings.filter(
    (f) => (f.check === "3.5" || f.check === "3.7") && f.effective?.payee?.id === approverId,
  );
}
