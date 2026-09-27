"use client";

import { useCallback, useEffect, useState } from "react";
import type { Finding, VerifyResult } from "@/lib/payroll/verify";
import SoloCloseSelect from "@/components/finance/SoloCloseSelect";
import { addDays, periodEndsCovering } from "@/lib/payroll/window";

// The schedule view's solo-close dropdowns (bj-finance #519, ruled
// 2026-09-22): one per night in the visible week that nobody's punch closed.
// Manager-only, like everything that decides pay.
//
// The nights come from the same rulebook the Finance tab runs
// (GET /api/payroll/verify). Pay periods end every other Sunday (ruled
// 2026-09-27), so the visible Sunday-to-Saturday week sits inside one period,
// or across two when its Sunday is the last day of one; each period it touches
// is verified and its nights shown. Choices are keyed by night, not by pay
// window, so what is chosen here is what the Finance tab and the payroll sheet
// read.

type Night = { finding: Finding; windowEnd: string };

export default function SoloCloseNights({ weekStart }: { weekStart: string }) {
  const weekEnd = addDays(weekStart, 6);
  const [nights, setNights] = useState<Night[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const found: Night[] = [];
    const errors: string[] = [];
    for (const windowEnd of periodEndsCovering(weekStart, weekEnd)) {
      const res = await fetch(`/api/payroll/verify?window_end=${windowEnd}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        errors.push(body.error ?? `Could not load solo-close nights (${res.status}).`);
        continue;
      }
      for (const finding of (body as VerifyResult).findings) {
        const date = finding.evidence.date;
        if (finding.check === "1.9" && !!date && date >= weekStart && date <= weekEnd)
          found.push({ finding, windowEnd });
      }
    }
    setError(errors.length ? errors.join(" ") : null);
    setNights(found);
  }, [weekStart, weekEnd]);

  useEffect(() => {
    load();
  }, [load]);

  if (nights === null || (nights.length === 0 && !error)) return null;

  return (
    <section className="mt-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Solo close — nights nobody&rsquo;s punch closed</div>
      <p className="text-xs text-slate-500 mt-1 max-w-prose">
        The last in-store clock-out was before 10 PM or well before close. Choose who, if anyone, is paid the $30
        solo-close bonus. Leaving it on skip pays nobody. Any manager can change these until the pay run is submitted on
        the Finance tab; submittal is final and locks them.
      </p>
      {error && <div className="text-xs text-rose-500 mt-2">{error}</div>}
      <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
        {nights.map(({ finding: f, windowEnd }) => (
          <li key={f.key} className="py-2">
            <div className="text-xs text-slate-700 dark:text-slate-300 mb-1">{f.summary}</div>
            <SoloCloseSelect finding={f} windowEnd={windowEnd} onSaved={load} />
          </li>
        ))}
      </ul>
    </section>
  );
}
