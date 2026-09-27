// Per-case payroll choices and the one run submittal (bj-finance #519, ruled
// 2026-09-22). Pure and dependency-free so `node --test` runs it, and the
// rulings route, the submit route and the UI all apply the same rules.

import { RULING_CHOICES, choicePays, type SubmittalRow, type Finding, type VerifyResult } from "./verify.ts";
import { firstSubmittalDay, periodEnded } from "./window.ts";

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

/** One case as it stood when the run was submitted. Stored on the submittal. */
export type SnapshotEntry = {
  key: string;
  check: string;
  choice: string;
  payee_id: string | null;
  payee_name: string | null;
  source: "recorded" | "default";
};

/** Every case with an effective choice, for the submittal's record. */
export function submittalSnapshot(findings: Finding[]): SnapshotEntry[] {
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
 * Why this run cannot be submitted, or null when it can.
 *
 * "Any manager can submit" (ruled 2026-09-22): the only conditions are the
 * data's and the calendar's, never who is asking. Submittal is FINAL and
 * cannot be undone, so a run is submitted once, only after its period has
 * ended, and never over a run that shares its days. Migration 27's trigger
 * refuses the same things in the database.
 */
export function submittalBlocker(
  result: Pick<VerifyResult, "ready" | "counts" | "window" | "submittal"> & { findings?: Finding[] },
  submittalsReady: boolean,
  today: string,
  otherSubmittals: Pick<SubmittalRow, "window_end">[] = [],
): string | null {
  if (!submittalsReady) return "Submittals need migration 27. Run it in Supabase first.";
  if (result.submittal) return "This pay run is already submitted. Submittal is final.";
  if (!periodEnded(result.window, today))
    return `The pay period ends ${result.window.end}. It can be submitted from ${firstSubmittalDay(result.window)}.`;
  const overlap = otherSubmittals.find((a) => a.window_end);
  if (overlap) return `The pay run ending ${overlap.window_end} is already submitted and shares days with this one.`;
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
  const what = f.check === "1.4" ? (f.evidence.open ? "open punch, no shift" : "runaway, no shift") : "short punch";
  const punch = f.evidence.punch_ids?.[0];
  const who = [f.evidence.employee_name ?? "someone", f.evidence.date].filter(Boolean).join(" ");
  return `${f.check} ${what}: ${who}${punch ? ` (punch ${punch})` : ""}`;
}

/** "Submitting this run would pay you": the §3.5/§3.7 flag, before it happens. */
export function paysSubmitter(findings: Finding[], submitterId: string): Finding[] {
  return findings.filter(
    (f) => (f.check === "3.5" || f.check === "3.7") && f.effective?.payee?.id === submitterId,
  );
}
