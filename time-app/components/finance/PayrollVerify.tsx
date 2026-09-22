"use client";

import { useState } from "react";
import type { CheckGroup, Finding, VerifyResult } from "@/lib/payroll/verify";

// The Verify timesheets screen (bj-finance #519, payroll spec §1).
//
// The whole rulebook lives in lib/payroll/verify.ts and runs on the server.
// This component does three things and nothing else: press the button, render
// what came back grouped by check, and record a ruling. It computes no findings
// and decides nothing — if it did, the rules would have two homes and the tests
// would only cover one of them.

type ApiResult = VerifyResult & { migrations: { storeHours: boolean; rulings: boolean } };

const SEVERITY_DOT: Record<string, string> = {
  error: "bg-rose-500",
  warn: "bg-amber-500",
  info: "bg-slate-400",
};

export default function PayrollVerify({ defaultWindowEnd }: { defaultWindowEnd: string }) {
  const [windowEnd, setWindowEnd] = useState(defaultWindowEnd);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify(end = windowEnd) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/payroll/verify?window_end=${encodeURIComponent(end)}`);
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? `Verify failed (${res.status}).`);
      setResult(null);
      return;
    }
    setResult(body as ApiResult);
  }

  // A ruling is recorded server-side and the whole window is then re-verified,
  // rather than the answer being patched into the findings here. Re-running is
  // the only way the green button means what it says: it is the same rulebook,
  // over the same data, with the answer now in it.
  async function rule(finding: Finding, choice: string, note: string) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/payroll/rulings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        window_end: result?.window.end ?? windowEnd,
        check_id: finding.check,
        finding_key: finding.key,
        choice,
        note: note || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBusy(false);
      setError(body.error ?? `Could not record that (${res.status}).`);
      return;
    }
    await verify(result?.window.end ?? windowEnd);
  }

  async function unrule(finding: Finding) {
    const end = result?.window.end ?? windowEnd;
    setBusy(true);
    setError(null);
    const params = new URLSearchParams({ window_end: end, check_id: finding.check, finding_key: finding.key });
    const res = await fetch(`/api/payroll/rulings?${params}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setBusy(false);
      setError(body.error ?? `Could not clear that (${res.status}).`);
      return;
    }
    await verify(end);
  }

  return (
    <div className="space-y-5">
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-xs text-slate-500 mb-1">Pay period ends (a Sunday)</span>
            <input
              type="date"
              value={windowEnd}
              onChange={(e) => setWindowEnd(e.target.value)}
              className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-slate-900 dark:text-slate-100"
            />
          </label>
          <button
            type="button"
            onClick={() => verify()}
            disabled={busy}
            className="rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 text-sm font-medium px-4 py-2 disabled:opacity-50"
          >
            {busy ? "Checking…" : "Verify timesheets"}
          </button>
          {result && <ReadyBadge result={result} />}
        </div>

        <p className="text-xs text-slate-500 mt-3 max-w-prose">
          The period is the 14 days ending the most recent Sunday, and the pay
          date is three days after it (spec 0.1). Nothing here reads
          QuickBooks&rsquo; own period list, which is misaligned with the periods
          this business runs.
        </p>

        {error && <div className="text-sm text-rose-500 mt-3">{error}</div>}
      </section>

      {result && (
        <>
          <Summary result={result} />
          {result.groups.map((group) => (
            <GroupCard key={group.check} group={group} busy={busy} onRule={rule} onClear={unrule} />
          ))}
        </>
      )}
    </div>
  );
}

function ReadyBadge({ result }: { result: ApiResult }) {
  if (result.ready) {
    return (
      <span className="rounded-md bg-emerald-500 text-slate-950 text-sm font-medium px-3 py-2">
        Timesheets verified
      </span>
    );
  }
  const waiting =
    result.counts.needsFix > 0
      ? `${result.counts.needsFix} to fix`
      : `${result.counts.needsRuling - result.counts.ruled} to rule on`;
  return (
    <span className="rounded-md bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-sm px-3 py-2">
      Not verified — {waiting}
    </span>
  );
}

function Summary({ result }: { result: ApiResult }) {
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 text-sm">
      <div className="text-slate-900 dark:text-slate-100 font-medium">
        {result.window.start} → {result.window.end} · pay date {result.window.payDate}
      </div>
      <div className="text-slate-600 dark:text-slate-400 mt-1">
        {result.counts.total} finding{result.counts.total === 1 ? "" : "s"}:{" "}
        {result.counts.autoResolved} resolved by rule, {result.counts.ruled} of{" "}
        {result.counts.needsRuling} rulings recorded, {result.counts.needsFix} needing a fix in the app.
      </div>
      {!result.migrations.storeHours && (
        <div className="text-amber-600 dark:text-amber-500 mt-2">
          Store hours are unavailable, so the mid-day gap check (1.8) judged nothing. Run migration 24.
        </div>
      )}
      {!result.migrations.rulings && (
        <div className="text-amber-600 dark:text-amber-500 mt-2">
          Rulings cannot be read or recorded. Run migration 27.
        </div>
      )}
    </section>
  );
}

function GroupCard({
  group,
  busy,
  onRule,
  onClear,
}: {
  group: CheckGroup;
  busy: boolean;
  onRule: (finding: Finding, choice: string, note: string) => void;
  onClear: (finding: Finding) => void;
}) {
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
      <header className="px-4 py-3 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800">
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {group.check} · {group.title}{" "}
          <span className="font-normal text-slate-500">({group.findings.length})</span>
        </div>
        {/* The spec's own words. This is the standard the finding below is held
            to, so it is on the screen rather than in a document elsewhere. */}
        <div className="text-xs text-slate-500 mt-1 max-w-prose">{group.rule}</div>
      </header>
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {group.findings.map((f) => (
          <li key={f.key} className="px-4 py-3">
            <FindingRow finding={f} busy={busy} onRule={onRule} onClear={onClear} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function FindingRow({
  finding,
  busy,
  onRule,
  onClear,
}: {
  finding: Finding;
  busy: boolean;
  onRule: (finding: Finding, choice: string, note: string) => void;
  onClear: (finding: Finding) => void;
}) {
  const [note, setNote] = useState("");

  return (
    <div className="flex gap-3">
      <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${SEVERITY_DOT[finding.severity]}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-900 dark:text-slate-100">{finding.summary}</div>

        {finding.resolution && (
          <div className="text-xs text-slate-600 dark:text-slate-400 mt-1">{finding.resolution}</div>
        )}

        <Evidence finding={finding} />

        {finding.status === "needs_ruling" && !finding.ruling && (
          <div className="mt-2 space-y-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="why (optional, kept with the ruling)"
              className="w-full max-w-md text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1"
            />
            <div className="flex flex-wrap gap-2">
              {finding.options?.map((o) => (
                <button
                  key={o.choice}
                  type="button"
                  disabled={busy}
                  onClick={() => onRule(finding, o.choice, note)}
                  title={o.effect}
                  className={`text-xs rounded-md px-3 py-1.5 border disabled:opacity-50 ${
                    o.choice === finding.defaultChoice
                      ? "border-emerald-500 text-emerald-700 dark:text-emerald-400"
                      : "border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                  }`}
                >
                  {o.label} — {o.effect}
                </button>
              ))}
            </div>
          </div>
        )}

        {finding.ruling && (
          <div className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
            Ruled: {labelFor(finding, finding.ruling.choice)}
            {finding.ruling.note ? ` — ${finding.ruling.note}` : ""}{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() => onClear(finding)}
              className="text-slate-500 hover:text-rose-500 underline disabled:opacity-50 ml-1"
            >
              change
            </button>
          </div>
        )}

        {finding.status === "needs_fix" && (
          <div className="mt-1 text-xs text-rose-500">
            Fix this in the app, then verify again. No ruling can stand in for it.
          </div>
        )}
      </div>
    </div>
  );
}

function labelFor(finding: Finding, choice: string): string {
  return finding.options?.find((o) => o.choice === choice)?.label ?? choice;
}

/**
 * The evidence line. Every finding carries what it was built from — punch ids,
 * shift ids, the interval — because a person asked to rule on somebody's pay
 * should be able to go and look at the rows themselves.
 */
function Evidence({ finding }: { finding: Finding }) {
  const e = finding.evidence;
  const parts: string[] = [];
  if (e.punch_ids?.length) parts.push(`punch ${e.punch_ids.join(", ")}`);
  if (e.shift_ids?.length) parts.push(`shift ${e.shift_ids.join(", ")}`);
  if (e.deal_id) parts.push(`deal ${e.deal_id}`);
  if (e.interval) parts.push(`${e.interval.from}–${e.interval.to}`);
  if (e.date && !e.interval) parts.push(e.date);
  if (typeof e.hours === "number") parts.push(`${e.hours}h`);
  if (e.notes?.length) parts.push(...e.notes);
  if (parts.length === 0) return null;
  return <div className="text-[11px] text-slate-500 mt-1 break-words">{parts.join(" · ")}</div>;
}
