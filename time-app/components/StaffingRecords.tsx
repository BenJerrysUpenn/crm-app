"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { LifecycleKind, LifecycleStep, LifecycleWithSteps } from "@/lib/types";

// The checklists under the Team table: one card per invite / re-invite /
// offboarding, one row per step. Automatic steps show what the app did,
// worker steps show what the onboarding worker did (or the wall it hit),
// and any non-automatic step can be marked done by hand.

export const KIND_LABEL: Record<LifecycleKind, string> = {
  onboarding: "Invite",
  reinvite: "Re-invite",
  offboarding: "Offboarding",
};

export const primaryBtn =
  "text-xs rounded-md bg-emerald-500 text-slate-950 font-medium px-3 py-1.5 hover:bg-emerald-400 disabled:opacity-50";
export const quietBtn =
  "text-xs rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";

export async function post(url: string, method: string, body: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Failed (${res.status}).`);
  return data;
}

export default function StaffingRecords({
  records,
  nameById,
}: {
  records: LifecycleWithSteps[];
  nameById: Record<string, string>;
}) {
  const open = records.filter((r) => r.status === "open");
  const closed = records.filter((r) => r.status !== "open");
  const [showClosed, setShowClosed] = useState(false);
  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">
        Invites &amp; offboarding in progress ({open.length})
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
        Square, Slack, QuickBooks and Google steps are queued for the onboarding worker, which
        signs in as the manager and does them; if it hits a login wall the step comes back here
        with the by-hand instructions. Tick anything you do yourself. A record closes itself
        when every step is done or skipped.
      </p>
      <div className="space-y-3">
        {open.length === 0 && <div className="text-sm text-slate-500">Nothing in progress.</div>}
        {open.map((r) => (
          <RecordCard key={r.id} rec={r} nameById={nameById} />
        ))}
      </div>
      {closed.length > 0 && (
        <div className="mt-4">
          <button type="button" onClick={() => setShowClosed((v) => !v)} className="text-xs text-slate-500 underline">
            {showClosed ? "Hide" : "Show"} finished ({closed.length})
          </button>
          {showClosed && (
            <div className="space-y-3 mt-3">
              {closed.map((r) => (
                <RecordCard key={r.id} rec={r} nameById={nameById} collapsed />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RecordCard({
  rec,
  nameById,
  collapsed = false,
}: {
  rec: LifecycleWithSteps;
  nameById: Record<string, string>;
  collapsed?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(!collapsed);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const form = rec.form as Record<string, unknown>;
  const who =
    (rec.employee_id && nameById[rec.employee_id]) ||
    (form.legal_name as string) ||
    (form.employee_name as string) ||
    "—";
  const done = rec.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const pendingAuto = rec.steps.some((s) => s.mode === "auto" && (s.status === "pending" || s.status === "failed"));
  const failed = rec.steps.some((s) => s.status === "failed");

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      await post(`/api/staffing/${rec.id}/run`, "POST", {});
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function setStatus(status: "open" | "cancelled") {
    setBusy(true);
    setMsg(null);
    try {
      await post(`/api/staffing/${rec.id}`, "PATCH", { status });
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const when = (form.start_date ?? form.last_day) as string | undefined;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <span className="text-xs uppercase tracking-wide text-slate-500">{KIND_LABEL[rec.kind]}</span>
        <span className="font-medium text-slate-900 dark:text-slate-100">{who}</span>
        {when && <span className="text-xs text-slate-500">{when}</span>}
        <span className="ml-auto text-xs text-slate-500">
          {done}/{rec.steps.length} steps
          {rec.status !== "open" && <span className="ml-2 capitalize">· {rec.status}</span>}
          {failed && <span className="ml-2 text-rose-500">· needs you</span>}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2 border-t border-slate-200 dark:border-slate-800 pt-3">
          {rec.steps.map((s) => (
            <StepRow key={s.id} rec={rec} step={s} nameById={nameById} />
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {rec.status === "open" && pendingAuto && (
              <button type="button" onClick={run} disabled={busy} className={primaryBtn}>
                {busy ? "Running…" : failed ? "Retry automatic steps" : "Run automatic steps"}
              </button>
            )}
            {rec.status === "open" && (
              <button type="button" onClick={() => setStatus("cancelled")} disabled={busy} className={quietBtn}>
                Cancel record
              </button>
            )}
            {rec.status === "cancelled" && (
              <button type="button" onClick={() => setStatus("open")} disabled={busy} className={quietBtn}>
                Reopen
              </button>
            )}
            {msg && <span className="text-xs text-rose-500">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function StepRow({
  rec,
  step,
  nameById,
}: {
  rec: LifecycleWithSteps;
  step: LifecycleStep;
  nameById: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [extra, setExtra] = useState("");
  const [expanded, setExpanded] = useState(step.status !== "done" && step.status !== "skipped");

  const needsExtra =
    step.key === "fob_assign" ? "fob_card_id" : step.key === "qbo_create_employee" ? "qbo_employee_id" : null;

  async function mark(skipped: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/staffing/${rec.id}/steps/${step.key}`, "PATCH", {
        note,
        skipped,
        fob_card_id: needsExtra === "fob_card_id" ? extra : undefined,
        qbo_employee_id: needsExtra === "qbo_employee_id" ? extra : undefined,
      });
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function reopen() {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/staffing/${rec.id}/steps/${step.key}`, "PATCH", { reopen: true });
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const badge =
    step.status === "done"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : step.status === "failed"
        ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
        : step.status === "skipped"
          ? "bg-slate-500/15 text-slate-500"
          : step.status === "running"
            ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
            : "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  const modeLabel = step.mode === "worker" ? "worker" : step.mode === "auto" ? "app" : "by hand";
  const canTick =
    step.mode !== "auto" && rec.status === "open" && (step.status === "pending" || step.status === "failed");

  const d = step.detail ?? {};

  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 px-3 py-2">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="w-full text-left flex items-start gap-2">
        <span className={`shrink-0 text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 mt-0.5 ${badge}`}>
          {step.status}
        </span>
        <span className="text-sm text-slate-900 dark:text-slate-100 flex-1">
          <span className="text-slate-400 mr-1">{step.seq}.</span>
          {step.label}
          <span className="ml-2 text-[10px] uppercase text-slate-400">{modeLabel}</span>
        </span>
      </button>
      {expanded && (
        <div className="mt-2 pl-1 space-y-1.5 text-xs text-slate-600 dark:text-slate-400">
          {d.link && (
            <div>
              <a href={d.link} target="_blank" rel="noreferrer" className="text-emerald-600 dark:text-emerald-400 underline break-all">
                {d.link}
              </a>
              {d.recipient && <span className="ml-2 text-slate-500">→ {d.recipient}</span>}
            </div>
          )}
          {(d.lines ?? []).map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">{l}</div>
          ))}
          {d.reason && <div className="italic text-slate-500">{d.reason}.</div>}
          {step.mode === "worker" && step.status === "pending" && (
            <div className="text-slate-500">Queued for the worker{step.attempts > 0 ? ` (attempt ${step.attempts})` : ""}. Or do it by hand and mark it done.</div>
          )}
          {step.worker_log && (
            <div className="text-slate-500 whitespace-pre-wrap">Worker: {step.worker_log}</div>
          )}
          {step.result && (
            <div className={step.status === "failed" ? "text-rose-500" : "text-slate-700 dark:text-slate-300"}>
              {step.status === "failed" ? "Failed: " : "Result: "}
              {step.result}
            </div>
          )}
          {step.completed_at && (
            <div className="text-slate-500">
              {step.status} {new Date(step.completed_at).toLocaleString()}
              {step.completed_by && nameById[step.completed_by]
                ? ` by ${nameById[step.completed_by]}`
                : step.mode === "worker" && step.status === "done"
                  ? " by the worker"
                  : ""}
            </div>
          )}
          {canTick && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {needsExtra && (
                <input
                  className="text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 w-44"
                  placeholder={needsExtra === "fob_card_id" ? "fob card id" : "QBO employee id"}
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                />
              )}
              <input
                className="text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 flex-1 min-w-[160px]"
                placeholder="note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button type="button" onClick={() => mark(false)} disabled={busy} className={primaryBtn}>
                {step.mode === "worker" ? "Done by hand" : "Mark done"}
              </button>
              <button type="button" onClick={() => mark(true)} disabled={busy} className={quietBtn}>
                Skip
              </button>
            </div>
          )}
          {step.mode !== "auto" && rec.status !== "cancelled" && (step.status === "done" || step.status === "skipped") && (
            <button type="button" onClick={reopen} disabled={busy} className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline">
              Reopen
            </button>
          )}
          {err && <div className="text-rose-500">{err}</div>}
        </div>
      )}
    </div>
  );
}
