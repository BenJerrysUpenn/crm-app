"use client";

import { useCallback, useEffect, useState } from "react";
import type { Finding, VerifyResult } from "@/lib/payroll/verify";
import SoloCloseSelect from "@/components/finance/SoloCloseSelect";
import { periodEndsCovering } from "@/lib/payroll/window";

// The solo-close dropdowns (bj-finance #519, ruled 2026-09-22): one per night
// from `from` to `to` that nobody's punch closed. Manager-only, like everything
// that decides pay. It lives on the payroll page, under the verified pay
// period, which passes that period's first and last day.
//
// The nights come from the same rulebook the payroll page runs
// (GET /api/payroll/verify). Each pay period the dates touch is verified and
// its nights shown; for a whole pay period that is the period itself. Choices
// are keyed by night, not by pay window, so what is chosen here is what the
// payroll sheet reads. `onSaved` tells the page a choice was recorded, so it
// can re-verify.

type Night = { finding: Finding; windowEnd: string };

export default function SoloCloseNights({
  from,
  to,
  onSaved,
}: {
  from: string;
  to: string;
  onSaved?: () => void;
}) {
  const [nights, setNights] = useState<Night[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const found: Night[] = [];
    const errors: string[] = [];
    for (const windowEnd of periodEndsCovering(from, to)) {
      const res = await fetch(`/api/payroll/verify?window_end=${windowEnd}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        errors.push(body.error ?? `Could not load solo-close nights (${res.status}).`);
        continue;
      }
      for (const finding of (body as VerifyResult).findings) {
        const date = finding.evidence.date;
        if (finding.check === "1.9" && !!date && date >= from && date <= to)
          found.push({ finding, windowEnd });
      }
    }
    setError(errors.length ? errors.join(" ") : null);
    setNights(found);
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  if (nights === null || (nights.length === 0 && !error)) return null;

  return (
    <section id="solo-close" className="mt-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
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
            <SoloCloseSelect
              finding={f}
              windowEnd={windowEnd}
              onSaved={() => {
                load();
                onSaved?.();
              }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
