"use client";

// The Team page's annual salary for a salaried person (bj-finance #693). A
// salary is dated like every control-board value: setting a new one adds a
// row in force from its as-of date, and the old one stays in the history
// (migration 43). The control board's fixed payroll is built from these.
// Owners set salaries; other managers see them.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addMonthsTo, historyOf, inForce, type SalaryRow } from "@/lib/controlBoard/settings";
import { money, shortDate } from "@/lib/controlBoard/format";
import ReviewChip from "@/components/finance/targets/ReviewChip";

/** The cell in the staff table: the salary in force today, or why there is none. */
export function SalaryCell({ rows, today, salaried, open, onToggle }: {
  rows: SalaryRow[] | null; today: string; salaried: boolean; open: boolean; onToggle: () => void;
}) {
  if (!salaried) return <span className="text-slate-400">—</span>;
  if (rows == null) return <span className="text-[11px] text-slate-400" title="Needs migration 43">not set up</span>;
  const now = inForce(rows, today);
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="inline-flex items-center gap-1.5 text-right hover:underline whitespace-nowrap">
      <span className="font-mono tabular-nums">{now ? money(now.annual_salary) : "Not set"}</span>
      {now && <ReviewChip reviewBy={now.review_by} today={today} compact />}
    </button>
  );
}

const inputCls = "rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-sm text-slate-900 dark:text-slate-100";

/** Under the person's row when their salary is opened: the history, and for an owner, a new salary. */
export function SalaryPanel({ profileId, name, rows, today, viewerIsOwner }: {
  profileId: string; name: string; rows: SalaryRow[]; today: string; viewerIsOwner: boolean;
}) {
  const router = useRouter();
  const now = inForce(rows, today);
  const [amount, setAmount] = useState("");
  const [asOf, setAsOf] = useState(today);
  const [reviewBy, setReviewBy] = useState(now && now.review_by > today ? now.review_by : addMonthsTo(today, 12));
  const [source, setSource] = useState("");
  const [method, setMethod] = useState(now?.method ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setMsg(null);
    setBusy(true);
    const res = await fetch("/api/payroll/targets/salary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId, annual_salary: amount, effective_from: asOf, review_by: reviewBy, source, method }),
    });
    setBusy(false);
    if (res.ok) {
      setAmount("");
      setSource("");
      setMsg({ ok: true, text: "Saved." });
      router.refresh();
      return;
    }
    const body = await res.json().catch(() => ({}));
    setMsg({ ok: false, text: body.error ?? `Save failed (${res.status}).` });
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 text-xs">
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{name}: salary history</div>
        <ol className="space-y-1.5">
          {historyOf(rows).map((h) => (
            <li key={h.id}>
              <span className="font-mono tabular-nums">{money(h.annual_salary)}</span>
              <span className="text-slate-500">
                {" "}from {shortDate(h.effective_from)}
                {h.id === now?.id ? " · in force now" : h.effective_from > today ? " · not in force yet" : ""}
                {" "}· {h.source}
                {h.method ? ` · ${h.method}` : ""}
              </span>
            </li>
          ))}
          {rows.length === 0 && <li className="text-slate-500">No salary on file.</li>}
        </ol>
      </div>
      {viewerIsOwner ? (
        <div className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">New salary</div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">$<input aria-label="Annual salary" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="a year" className={`${inputCls} w-28 text-right font-mono`} /></label>
            <label className="flex items-center gap-1 text-slate-500">from <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={inputCls} /></label>
            <label className="flex items-center gap-1 text-slate-500">review by <input type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} className={inputCls} /></label>
          </div>
          <input aria-label="Where it came from" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Where it came from (offer letter, payroll record…)" className={`${inputCls} w-full`} />
          <input aria-label="How it was worked out" value={method} onChange={(e) => setMethod(e.target.value)} placeholder="How it was worked out (optional)" className={`${inputCls} w-full`} />
          <div className="flex items-center gap-2">
            <button type="button" onClick={save} disabled={busy || !amount.trim()} className="rounded-md bg-emerald-500 px-3 py-1 font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50">
              {busy ? "Saving…" : "Save salary"}
            </button>
            {msg && <span className={msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>{msg.text}</span>}
          </div>
          <p className="text-slate-500">A new salary is in force from its date; the old one stays in the history.</p>
        </div>
      ) : (
        <p className="text-slate-500">Owners set salaries.</p>
      )}
    </div>
  );
}
