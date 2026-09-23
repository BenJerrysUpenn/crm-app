"use client";

import { useState } from "react";
import type { Finding } from "@/lib/payroll/verify";
import { recordChoice } from "./choiceApi";

// The §1.9 solo-close dropdown for one night (bj-finance #519, ruled
// 2026-09-22): pay the scheduled closer / pay an unpunched manager / skip.
// Default skip. It lives on the schedule view; the Finance tab only shows what
// was chosen. The options, the scheduled closer and the managers all come from
// the server's rulebook (lib/payroll/verify.ts); nothing is worked out here.
//
// One <select> carries both the choice and, for "unpunched manager", which
// manager: `unpunched_manager:<profile id>`.

export default function SoloCloseSelect({
  finding,
  windowEnd,
  onSaved,
}: {
  finding: Finding;
  windowEnd: string;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effective = finding.effective;
  const current =
    effective?.choice === "unpunched_manager" && effective.payee
      ? `unpunched_manager:${effective.payee.id}`
      : effective?.choice ?? "skip";
  const closer = finding.scheduledCloser ?? null;

  async function change(value: string) {
    const [choice, managerId] = value.split(":");
    const payee = choice === "scheduled_closer" ? closer?.id ?? null : choice === "unpunched_manager" ? managerId : null;
    setBusy(true);
    setError(null);
    const err = await recordChoice(windowEnd, finding, choice, payee);
    setBusy(false);
    setError(err);
    if (!err) onSaved();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={current}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
        className="text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 disabled:opacity-50"
        title="Solo-close bonus for this night (payroll spec 1.9 / 2.4)"
      >
        <option value="skip">Skip payment{finding.defaultChoice === "skip" ? " (default)" : ""}</option>
        <option value="scheduled_closer" disabled={!closer}>
          Pay scheduled closer{closer ? ` — ${closer.name}` : " (nobody scheduled)"}
        </option>
        {(finding.candidates ?? []).map((m) => (
          <option key={m.id} value={`unpunched_manager:${m.id}`}>
            Pay unpunched manager — {m.name}
          </option>
        ))}
      </select>
      {effective?.source === "recorded" && (
        <span className="text-[11px] text-slate-500">changed from default</span>
      )}
      {(finding.flags ?? []).map((flag) => (
        <span key={flag} className="text-[11px] text-amber-600 dark:text-amber-500">⚑ {flag}</span>
      ))}
      {error && <span className="text-[11px] text-rose-500">{error}</span>}
    </div>
  );
}
