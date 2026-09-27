// Browser-side calls for per-case payroll choices (bj-finance #519). Both the
// Finance tab and the schedule's solo-close dropdowns use these, so a choice is
// recorded the same way wherever it is made. Each returns an error message, or
// null when the server accepted it.

import type { Finding } from "@/lib/payroll/verify";

export async function recordChoice(
  windowEnd: string,
  finding: Finding,
  choice: string,
  payeeId: string | null,
  note?: string,
): Promise<string | null> {
  const res = await fetch("/api/payroll/rulings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      window_end: windowEnd,
      check_id: finding.check,
      finding_key: finding.key,
      choice,
      payee_id: payeeId ?? undefined,
      note: note || undefined,
    }),
  });
  if (res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return body.error ?? `Could not record that (${res.status}).`;
}

/** Back to the default (or, for a case with none, back to unanswered). */
export async function resetChoice(windowEnd: string, finding: Finding): Promise<string | null> {
  const params = new URLSearchParams({ window_end: windowEnd, check_id: finding.check, finding_key: finding.key });
  const res = await fetch(`/api/payroll/rulings?${params}`, { method: "DELETE" });
  if (res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return body.error ?? `Could not reset that (${res.status}).`;
}
