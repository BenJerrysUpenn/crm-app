"use client";

import { useState } from "react";
import Link from "next/link";
import type { CheckGroup, Finding } from "@/lib/payroll/verify";
import type { LoadedVerify } from "@/lib/payroll/loadVerify";
import { approvalBlocker, paysApprover } from "@/lib/payroll/choices";
import { recordChoice, resetChoice } from "./choiceApi";

// The Verify timesheets screen (bj-finance #519, payroll spec §1).
//
// The whole rulebook lives in lib/payroll/verify.ts and runs on the server.
// This component does four things and nothing else: press the button, render
// what came back grouped by check, record a per-case choice, and approve the
// run. It computes no findings and decides nothing — if it did, the rules would
// have two homes and the tests would only cover one of them.
//
// Ruled 2026-09-22: every judgement call is a per-case choice with a
// PRESELECTED DEFAULT, and there is ONE approval for the whole run, which any
// manager may give. The §1.9 solo-close dropdown lives on the schedule view;
// this tab shows what was chosen and links there.

type ApiResult = LoadedVerify;

const SEVERITY_DOT: Record<string, string> = {
  error: "bg-rose-500",
  warn: "bg-amber-500",
  info: "bg-slate-400",
};

export default function PayrollVerify({ defaultWindowEnd, meId }: { defaultWindowEnd: string; meId: string }) {
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

  // A choice is recorded server-side and the whole window is then re-verified,
  // rather than the answer being patched into the findings here. Re-running is
  // the only way the button means what it says: it is the same rulebook, over
  // the same data, with the answer now in it.
  async function rule(finding: Finding, choice: string, payeeId: string | null, note: string) {
    const end = result?.window.end ?? windowEnd;
    setBusy(true);
    setError(null);
    const err = await recordChoice(end, finding, choice, payeeId, note);
    if (err) {
      setBusy(false);
      setError(err);
      return;
    }
    await verify(end);
  }

  async function unrule(finding: Finding) {
    const end = result?.window.end ?? windowEnd;
    setBusy(true);
    setError(null);
    const err = await resetChoice(end, finding);
    if (err) {
      setBusy(false);
      setError(err);
      return;
    }
    await verify(end);
  }

  async function approve() {
    const end = result?.window.end ?? windowEnd;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/payroll/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ window_end: end }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setBusy(false);
      setError(body.error ?? `Could not approve (${res.status}).`);
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
          <ApprovePanel result={result} meId={meId} busy={busy} onApprove={approve} />
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
      : `${result.counts.needsRuling - result.counts.ruled - result.counts.defaulted} to answer`;
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
        {result.counts.autoResolved} resolved by rule, {result.counts.needsRuling} case
        {result.counts.needsRuling === 1 ? "" : "s"} to choose ({result.counts.ruled} changed or answered,{" "}
        {result.counts.defaulted} on their default), {result.counts.needsFix} needing a fix in the app.
      </div>
      {!result.migrations.storeHours && (
        <div className="text-amber-600 dark:text-amber-500 mt-2">
          Store hours are unavailable, so the mid-day gap check (1.8) judged nothing. Run migration 24.
        </div>
      )}
      {(!result.migrations.rulings || !result.migrations.approvals) && (
        <div className="text-amber-600 dark:text-amber-500 mt-2">
          Choices and the run approval cannot be read or recorded. Run migration 27.
        </div>
      )}
    </section>
  );
}

/**
 * The one approval for the whole run. Any manager may give it; the only
 * conditions are the data's. Flags never block — they are here so the person
 * approving sees, before they click, anything that pays a manager by a choice.
 */
function ApprovePanel({
  result,
  meId,
  busy,
  onApprove,
}: {
  result: ApiResult;
  meId: string;
  busy: boolean;
  onApprove: () => void;
}) {
  const blocker = approvalBlocker(result, result.migrations.approvals);
  const wouldPayMe = paysApprover(result.findings, meId);
  const state = result.approvalState;
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="font-medium text-slate-900 dark:text-slate-100">
          {state === "approved" && "Pay run approved"}
          {state === "stale" && "Approval is stale — a choice changed after it was given"}
          {state === "not_approved" && "Pay run not approved"}
        </div>
        {result.approval && (
          <div className="text-xs text-slate-500">
            last approved {new Date(result.approval.approved_at).toLocaleString("en-US", { timeZone: "America/New_York" })}
          </div>
        )}
        <button
          type="button"
          onClick={onApprove}
          disabled={busy || !!blocker}
          title={blocker ?? "Approve every case as it stands, defaults included"}
          className="ml-auto rounded-md bg-emerald-600 text-white text-sm font-medium px-4 py-2 disabled:opacity-40"
        >
          {state === "approved" ? "Approve again" : "Approve pay run"}
        </button>
      </div>
      {blocker && <div className="text-xs text-slate-500 mt-2">{blocker}</div>}
      {result.flags.length > 0 && (
        <ul className="mt-2 space-y-1">
          {result.flags.map((flag) => (
            <li key={`${flag.key}|${flag.message}`} className="text-xs text-amber-600 dark:text-amber-500">
              ⚑ {flag.message}
            </li>
          ))}
        </ul>
      )}
      {wouldPayMe.length > 0 && state !== "approved" && (
        <div className="text-xs text-amber-600 dark:text-amber-500 mt-2">
          ⚑ Approving pays you {wouldPayMe.length === 1 ? "one tip" : `${wouldPayMe.length} tips`} chosen here (
          {wouldPayMe.map((f) => f.key).join(", ")}). That is allowed, and it is flagged on the payroll sheet.
        </div>
      )}
      <p className="text-xs text-slate-500 mt-2 max-w-prose">
        One approval covers the whole run. Every case stands on its default unless a manager changed it. The payroll
        sheet will not produce a keyable sheet until the run is approved, and a choice changed after approval needs
        approving again.
      </p>
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
  onRule: (finding: Finding, choice: string, payeeId: string | null, note: string) => void;
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
  onRule: (finding: Finding, choice: string, payeeId: string | null, note: string) => void;
  onClear: (finding: Finding) => void;
}) {
  const [note, setNote] = useState("");
  const hasDefault = !!finding.defaultChoice;

  return (
    <div className="flex gap-3">
      <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${SEVERITY_DOT[finding.severity]}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-900 dark:text-slate-100">{finding.summary}</div>

        {finding.resolution && (
          <div className="text-xs text-slate-600 dark:text-slate-400 mt-1">{finding.resolution}</div>
        )}

        <Evidence finding={finding} />

        {hasDefault && <ChoiceRow finding={finding} busy={busy} onRule={onRule} onClear={onClear} />}

        {finding.status === "needs_ruling" && !hasDefault && !finding.ruling && (
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
                  onClick={() => onRule(finding, o.choice, null, note)}
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

        {!hasDefault && finding.ruling && (
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

/**
 * A case with a preselected default (§1.9, §3.5, §3.7). The default is shown as
 * already standing; changing it records a choice, and "reset" puts the default
 * back. §1.9 is changed on the schedule, per the ruling, so here it is shown
 * with a link there.
 */
function ChoiceRow({
  finding,
  busy,
  onRule,
  onClear,
}: {
  finding: Finding;
  busy: boolean;
  onRule: (finding: Finding, choice: string, payeeId: string | null, note: string) => void;
  onClear: (finding: Finding) => void;
}) {
  const effective = finding.effective;
  const recorded = effective?.source === "recorded";
  const payeeName = effective?.payee?.name;
  return (
    <div className="mt-2 text-xs space-y-1">
      {finding.check === "1.9" ? (
        <div className="text-slate-700 dark:text-slate-300">
          {labelFor(finding, effective?.choice ?? "skip").replace(/ \(default\)$/, "")}
          {payeeName ? ` — ${payeeName}` : ""} {recorded ? "(changed from default)" : "(default)"}{" "}
          {finding.evidence.date && (
            <Link href={`/schedule?week=${finding.evidence.date}`} className="underline text-slate-500 hover:text-emerald-600 ml-1">
              change on the schedule
            </Link>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-600 dark:text-slate-400">Pay to</span>
          <select
            value={effective?.payee?.id ?? ""}
            disabled={busy}
            onChange={(e) => onRule(finding, finding.defaultChoice!, e.target.value || null, "")}
            className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 disabled:opacity-50"
          >
            {!effective?.payee && <option value="">— pick somebody —</option>}
            {(finding.candidates ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {finding.defaultPayee?.id === c.id ? " (default)" : ""}
              </option>
            ))}
          </select>
          {recorded && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onClear(finding)}
              className="text-slate-500 hover:text-rose-500 underline disabled:opacity-50"
            >
              reset to default
            </button>
          )}
        </div>
      )}
      {(finding.flags ?? []).map((flag) => (
        <div key={flag} className="text-amber-600 dark:text-amber-500">⚑ {flag}</div>
      ))}
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
