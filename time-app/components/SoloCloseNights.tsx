"use client";

import { useCallback, useEffect, useState } from "react";
import type { Finding, VerifyResult } from "@/lib/payroll/verify";
import SoloCloseSelect from "@/components/finance/SoloCloseSelect";

// The schedule view's solo-close dropdowns (bj-finance #519, ruled
// 2026-09-22): one per night in the visible week that nobody's punch closed.
// Manager-only, like everything that decides pay.
//
// The nights come from the same rulebook the Finance tab runs
// (GET /api/payroll/verify). The pay window ending the Sunday AFTER this
// week's Sunday spans the 14 days back to the Monday before it, so it covers
// every night on screen in one call. Choices are keyed by night, not by pay
// window, so what is chosen here is what the Finance tab and the payroll sheet
// read.

function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

export default function SoloCloseNights({ weekStart }: { weekStart: string }) {
  const windowEnd = addDays(weekStart, 7);
  const weekEnd = addDays(weekStart, 6);
  const [nights, setNights] = useState<Finding[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/payroll/verify?window_end=${windowEnd}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? `Could not load solo-close nights (${res.status}).`);
      setNights([]);
      return;
    }
    setError(null);
    setNights(
      (body as VerifyResult).findings.filter(
        (f) => f.check === "1.9" && !!f.evidence.date && f.evidence.date >= weekStart && f.evidence.date <= weekEnd,
      ),
    );
  }, [windowEnd, weekStart, weekEnd]);

  useEffect(() => {
    load();
  }, [load]);

  if (nights === null || (nights.length === 0 && !error)) return null;

  return (
    <section className="mt-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Solo close — nights nobody&rsquo;s punch closed</div>
      <p className="text-xs text-slate-500 mt-1 max-w-prose">
        The last in-store clock-out was before 10 PM or well before close. Choose who, if anyone, is paid the $30
        solo-close bonus. Leaving it on skip pays nobody. Any manager can change these until the pay run is approved on
        the Finance tab; approval is final and locks them.
      </p>
      {error && <div className="text-xs text-rose-500 mt-2">{error}</div>}
      <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
        {nights.map((f) => (
          <li key={f.key} className="py-2">
            <div className="text-xs text-slate-700 dark:text-slate-300 mb-1">{f.summary}</div>
            <SoloCloseSelect finding={f} windowEnd={windowEnd} onSaved={load} />
          </li>
        ))}
      </ul>
    </section>
  );
}
