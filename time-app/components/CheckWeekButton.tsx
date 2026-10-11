"use client";

import { useState } from "react";
import Modal from "./Modal";
import { describeGap, describeHoursNotSet, type CoverageGap, type HoursNotSetDay } from "@/lib/coverage";

type Result =
  | { kind: "checked"; gaps: CoverageGap[]; hoursNotSet: HoursNotSetDay[] }
  | { kind: "failed"; message: string };

/**
 * "Check week": runs the store-coverage check against the live shifts of the
 * week on screen and shows each opening hour nobody is scheduled in store for.
 * Managers only (renders nothing for anyone else). Read-only: it changes no
 * data and sends nothing.
 */
export default function CheckWeekButton({ isManager, weekStart }: { isManager: boolean; weekStart: string }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  if (!isManager) return null;

  async function checkWeek() {
    setChecking(true);
    try {
      const res = await fetch(`/api/schedule/check-week?weekStart=${encodeURIComponent(weekStart)}`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setResult({ kind: "checked", gaps: j.gaps ?? [], hoursNotSet: j.hoursNotSet ?? [] });
      } else {
        setResult({
          kind: "failed",
          message:
            j.error === "store_hours_not_set_up"
              ? "Store hours aren't set up yet, so there is nothing to check against. Set them on the Team page."
              : "Something went wrong reading the schedule or the store hours. Try again in a moment.",
        });
      }
    } catch {
      setResult({ kind: "failed", message: "Couldn't reach the server. Try again in a moment." });
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <button
        onClick={checkWeek}
        disabled={checking}
        className="px-2.5 py-1 text-sm rounded-md border border-slate-400 dark:border-slate-600 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
      >
        {checking ? "Checking…" : "Check week"}
      </button>

      {result && (
        <Modal onClose={() => setResult(null)} className="max-w-lg space-y-3">
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">
            {result.kind === "failed"
              ? "Store coverage couldn't be checked"
              : result.gaps.length > 0
                ? "Nobody is in the store"
                : "All opening hours covered"}
          </h2>
          {result.kind === "failed" ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">{result.message}</p>
          ) : (
            <>
              {result.gaps.length > 0 ? (
                <>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    The store is open at these times this week, and no one is scheduled in store:
                  </p>
                  <ul className="space-y-1 rounded-md border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2">
                    {result.gaps.map((g) => (
                      <li key={`${g.date}-${g.from}-${g.to}`} className="text-sm text-amber-900 dark:text-amber-200">
                        {describeGap(g)}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Somebody is scheduled in store for every hour the store is open this week.
                </p>
              )}
              {result.hoursNotSet.length > 0 && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Store hours aren&apos;t set for {describeHoursNotSet(result.hoursNotSet)}. Set them on the Team page — those days weren&apos;t checked.
                </p>
              )}
            </>
          )}
          <div className="flex justify-end pt-1">
            <button
              onClick={() => setResult(null)}
              className="px-3 py-1.5 text-sm rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400"
            >
              Close
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
