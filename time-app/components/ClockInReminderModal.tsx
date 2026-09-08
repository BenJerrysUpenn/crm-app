"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtDate } from "@/lib/format";
import type { ClockinReminder } from "@/lib/types";

// A blocking popup: no X, no backdrop dismiss, no Escape. Acknowledging is
// the only way out, and the only way to reach the clock-in button.
export default function ClockInReminderModal({
  reminders,
}: {
  reminders: ClockinReminder[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = reminders.length > 0;

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!open) return null;

  async function acknowledge() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/clockin-reminders/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: reminders.map((r) => r.id) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json.error ?? "Could not record your acknowledgment.");
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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="clockin-reminder-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
    >
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl">
        <div className="px-5 pt-5">
          <h2
            id="clockin-reminder-title"
            className="text-lg font-semibold text-slate-900 dark:text-slate-100"
          >
            Clock-in reminder
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Please read and acknowledge before clocking in.
          </p>
        </div>

        <div className="px-5 py-4 max-h-[55vh] overflow-y-auto space-y-4">
          {reminders.map((r) => (
            <div
              key={r.id}
              className="border-b border-slate-200 dark:border-slate-800 pb-4 last:border-0 last:pb-0"
            >
              <div className="font-semibold text-slate-900 dark:text-slate-100">{r.title}</div>
              <div className="text-sm text-slate-700 dark:text-slate-300 mt-1 whitespace-pre-wrap">
                {r.body}
              </div>
              <div className="text-xs text-slate-500 mt-2">Posted {fmtDate(r.created_at)}</div>
            </div>
          ))}
        </div>

        <div className="px-5 pb-5">
          <button
            onClick={acknowledge}
            disabled={busy}
            className="w-full py-4 rounded-xl text-lg font-semibold transition bg-emerald-500 hover:bg-emerald-400 text-slate-950 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Acknowledge"}
          </button>
          {err && (
            <div className="text-sm text-rose-300 bg-rose-950 border border-rose-900 rounded-md px-3 py-2 mt-3">
              {err}
            </div>
          )}
          <div className="text-xs text-slate-500 mt-3 text-center">
            Your acknowledgment is recorded with your name and the time.
          </div>
        </div>
      </div>
    </div>
  );
}
