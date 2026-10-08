"use client";

// The Reimbursements tab of Withers Finance (bj-finance #210, ruling 21): the
// queue of Submitted Travel Reimbursements for an Approver to approve or
// reject (with a reason), Adjustments to any amount (evidence file and a
// one-line note), and the Approved ones not yet Paid, which an Approver can
// send back and an owner's can be marked Paid outside payroll. A second person
// on the same Catering Event is shown beside each, never blocked (ruling 24).
// One with no Mileage rate for its trip date has no total and offers no
// Approve (42). The Adjust panel shows the amount as it stands, pre-filled
// (43). What leaves the queue (Rejected, Paid, Paid outside payroll) is listed
// under a collapsed Decided at the bottom, newest first (41).

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DecidedItem, QueueItem } from "@/lib/reimbursements/load";
import { ADJUSTMENT_FIELDS, DECIDED_SHOWN, FIELD_LABEL, type AdjustmentField } from "@/lib/reimbursements/lifecycle";
import { reasonLabel } from "@/lib/reimbursements/events";
import { approveRefusal, fieldCents, dollarsText } from "@/lib/reimbursements/money";
import { money } from "@/lib/payroll/paySheet";
import { ReimbursementDetail, StatusBadge, BUTTON, PRIMARY, INPUT, uploadFile } from "@/components/reimbursements/shared";

const fileHref = (path: string) => `/api/payroll/reimbursements/file?path=${encodeURIComponent(path)}`;

type Panel = { id: number; kind: "reject" | "adjust" } | null;

/** Who took it off the queue and when, e.g. "Rejected by Sophia Manager on 2026-10-08: Which store?". */
function decisionLine(d: DecidedItem): string {
  const on = d.decided_on ? ` on ${d.decided_on}` : "";
  if (d.status === "rejected") return `Rejected by ${d.decided_by_name ?? "an Approver"}${on}${d.rejection_reason ? `: ${d.rejection_reason}` : ""}`;
  if (d.status === "paid_outside_payroll") return `Paid outside payroll, marked by ${d.decided_by_name ?? "an owner"}${on}`;
  return `Paid by payroll${d.decided_on ? `, pay date ${d.decided_on}` : ""}`;
}

export default function ReimbursementQueue({
  submitted,
  approved,
  decided,
  viewerIsOwner,
}: {
  submitted: QueueItem[];
  approved: QueueItem[];
  decided: DecidedItem[];
  viewerIsOwner: boolean;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ id: number; text: string; error: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const [field, setField] = useState<AdjustmentField>("mileage");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState<File | null>(null);

  function open(p: Panel, item?: QueueItem) {
    setPanel(p);
    setReason("");
    setField("mileage");
    setAmount(item ? dollarsText(fieldCents(item.amounts, "mileage")) : "");
    setNote("");
    setEvidence(null);
    setMsg(null);
  }

  /** The Adjust panel's amount follows the field picked: what it is now (ruling 43). */
  function pickField(item: QueueItem, f: AdjustmentField) {
    setField(f);
    setAmount(dollarsText(fieldCents(item.amounts, f)));
  }

  async function post(id: number, path: string, body: unknown, done: string) {
    setBusy(id);
    setMsg(null);
    const res = await fetch(`/api/payroll/reimbursements/${id}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return setMsg({ id, text: payload.error || "That did not work.", error: true });
    setPanel(null);
    setMsg({ id, text: payload.receipts_emailed ? `${done} Receipts sent to receipts@.` : done, error: false });
    router.refresh();
  }

  async function adjust(item: QueueItem) {
    if (!evidence) return setMsg({ id: item.id, text: "Attach the evidence (e.g. a screenshot of the conversation).", error: true });
    setBusy(item.id);
    try {
      const path = await uploadFile("/api/payroll/reimbursements/evidence-url", { reimbursement_id: item.id }, evidence);
      await post(item.id, "adjust", { field, amount, note, evidence_path: path }, "Adjusted. The staff member has been told.");
    } catch (e) {
      setBusy(null);
      setMsg({ id: item.id, text: e instanceof Error ? e.message : String(e), error: true });
    }
  }

  function card(item: QueueItem) {
    const mine = busy === item.id;
    const noApprove = approveRefusal(item.amounts, item.trip_date);
    return (
      <li key={item.id} className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {item.full_name ?? "Unknown"}
              {item.owner && <span className="ml-2 text-xs font-normal text-slate-500">owner: paid outside payroll</span>}
            </div>
            <ReimbursementDetail r={item} fileHref={fileHref} evidence />
          </div>
          <StatusBadge status={item.status} />
        </div>

        {item.also.length > 0 && (
          <div className="text-sm rounded-md bg-amber-50 dark:bg-amber-500/10 border border-amber-300/60 dark:border-amber-500/30 px-3 py-2 text-amber-900 dark:text-amber-200">
            Also submitted for this event: {item.also.map((a) => `${a.full_name ?? "someone"}, ${a.miles.toFixed(1)} mi`).join("; ")}
          </div>
        )}

        {item.refused ? (
          <div className="text-xs text-slate-500">{item.refused}</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {item.status === "submitted" && (
              <>
                {noApprove ? (
                  <span className="basis-full text-sm text-amber-700 dark:text-amber-400">{noApprove}</span>
                ) : (
                  <button className={PRIMARY} disabled={mine} onClick={() => post(item.id, "decide", { action: "approve" }, "Approved.")}>
                    Approve
                  </button>
                )}
                <button className={BUTTON} disabled={mine} onClick={() => open({ id: item.id, kind: "reject" })}>
                  Reject
                </button>
              </>
            )}
            {item.status === "approved" && (
              <button className={BUTTON} disabled={mine} onClick={() => post(item.id, "decide", { action: "send_back" }, "Sent back to Submitted.")}>
                Send back
              </button>
            )}
            {item.status === "approved" && item.owner && viewerIsOwner && (
              <button className={PRIMARY} disabled={mine} onClick={() => post(item.id, "decide", { action: "paid_outside_payroll" }, "Marked Paid outside payroll.")}>
                Paid outside payroll
              </button>
            )}
            <button className={BUTTON} disabled={mine} onClick={() => open({ id: item.id, kind: "adjust" }, item)}>
              Adjust
            </button>
          </div>
        )}

        {panel?.id === item.id && panel.kind === "reject" && (
          <div className="space-y-2">
            <label className="block text-sm text-slate-700 dark:text-slate-300">
              Why is it rejected? The staff member sees this.
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={INPUT} />
            </label>
            <div className="flex gap-2">
              <button className={PRIMARY} disabled={mine} onClick={() => post(item.id, "decide", { action: "reject", reason }, "Rejected. The staff member has been told.")}>
                Reject
              </button>
              <button className={BUTTON} onClick={() => setPanel(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {panel?.id === item.id && panel.kind === "adjust" && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm text-slate-700 dark:text-slate-300">
                Amount
                <select value={field} onChange={(e) => pickField(item, e.target.value as AdjustmentField)} className={INPUT}>
                  {ADJUSTMENT_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {FIELD_LABEL[f]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-slate-700 dark:text-slate-300">
                New amount
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$0.00" className={INPUT} />
              </label>
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400">
              {FIELD_LABEL[field]} now: {money(fieldCents(item.amounts, field))}
            </div>
            <label className="block text-sm text-slate-700 dark:text-slate-300">
              Note (one line, the staff member sees it)
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={INPUT} />
            </label>
            <label className="block text-sm text-slate-700 dark:text-slate-300">
              Evidence (e.g. a screenshot of the conversation that settled it)
              <input type="file" accept="image/*,application/pdf" onChange={(e) => setEvidence(e.target.files?.[0] ?? null)} className="mt-1 block text-sm" />
            </label>
            <div className="flex gap-2">
              <button className={PRIMARY} disabled={mine} onClick={() => adjust(item)}>
                Save Adjustment
              </button>
              <button className={BUTTON} onClick={() => setPanel(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {msg?.id === item.id && (
          <div className={`text-sm ${msg.error ? "text-rose-600 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{msg.text}</div>
        )}
      </li>
    );
  }

  // A decision that took the item off the queue: say so here, since its card has gone.
  const left = msg && !msg.error && ![...submitted, ...approved].some((i) => i.id === msg.id) ? msg : null;

  return (
    <div className="space-y-6">
      {left && (
        <div className="text-sm rounded-md border border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-emerald-800 dark:text-emerald-300">
          {left.text} It is listed under Decided at the bottom.
        </div>
      )}
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Submitted ({submitted.length})</h2>
        {submitted.length === 0 ? (
          <div className="text-sm text-slate-500">Nothing waiting for an Approver.</div>
        ) : (
          <ul className="space-y-3">{submitted.map(card)}</ul>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Approved, not yet Paid ({approved.length})</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Staff are paid on the next pay table, as one Travel Reimbursement amount per person; payroll marks them Paid when the run is submitted. An owner&apos;s is paid outside payroll: an owner marks it here.
        </p>
        {approved.length === 0 ? (
          <div className="text-sm text-slate-500">None.</div>
        ) : (
          <ul className="space-y-3">{approved.map(card)}</ul>
        )}
      </section>
      <details className="group rounded-lg border border-slate-200 dark:border-slate-800">
        <summary className="cursor-pointer select-none px-4 py-3 text-base font-semibold text-slate-900 dark:text-slate-100">
          Decided ({decided.length}
          {decided.length >= DECIDED_SHOWN ? ", the latest" : ""})
        </summary>
        {decided.length === 0 ? (
          <div className="px-4 pb-4 text-sm text-slate-500">Nothing rejected or paid yet.</div>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800 border-t border-slate-200 dark:border-slate-800">
            {decided.map((d) => (
              <li key={d.id} className="px-4 py-3 space-y-1 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-slate-900 dark:text-slate-100">
                    <span className="font-semibold">{d.full_name ?? "Unknown"}</span>
                    {" · "}
                    {reasonLabel(d)}
                  </div>
                  <StatusBadge status={d.status} />
                </div>
                <div className="text-slate-600 dark:text-slate-400">
                  Trip {d.trip_date} · Total {money(d.amounts.total_cents)}
                </div>
                <div className="text-slate-700 dark:text-slate-300">{decisionLine(d)}</div>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
