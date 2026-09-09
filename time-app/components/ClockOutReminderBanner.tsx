"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtTime } from "@/lib/format";

// A nudge, not a gate: it sits above the clock card and never blocks anything.
// Snooze hides it for the reminder interval; dismiss retires it for this entry.
export default function ClockOutReminderBanner({
  entryId,
  shiftEndsAt,
  snoozeMin,
}: {
  entryId: number;
  shiftEndsAt: string;
  snoozeMin: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function act(action: "snooze" | "dismiss") {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/time-entries/${entryId}/clockout-reminder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json.error ?? "Could not update the reminder.");
      } else {
        router.refresh();
      }
    } catch {
      setErr("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-900 rounded-xl px-4 py-3 mb-6">
      <div className="font-semibold">Still clocked in?</div>
      <div className="text-sm mt-1">
        Your shift ended at {fmtTime(shiftEndsAt)}. If you&apos;ve left, use the Clock out
        button below.
      </div>
      <div className="flex gap-2 mt-3">
        <button
          onClick={() => act("snooze")}
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded-md border border-amber-300 dark:border-amber-800 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/50 disabled:opacity-50"
        >
          Snooze {snoozeMin} min
        </button>
        <button
          onClick={() => act("dismiss")}
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded-md border border-amber-300 dark:border-amber-800 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/50 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
      {err && (
        <div className="text-sm text-rose-300 bg-rose-950 border border-rose-900 rounded-md px-3 py-2 mt-3">
          {err}
        </div>
      )}
    </div>
  );
}
