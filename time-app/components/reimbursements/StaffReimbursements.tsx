"use client";

// The Reimbursements page of Withers Time (bj-finance #210, ruling 31): a New
// button and the staff member's own history, with each one's status, the
// rejection reason, and any Adjustment (old amount → new amount, and the note).
// Everyone sees it, owners included (ruling 13).

import { useState } from "react";
import { useRouter } from "next/navigation";
import Modal from "@/components/Modal";
import { reasonLabel } from "@/lib/reimbursements/events";
import { staffMayChange } from "@/lib/reimbursements/lifecycle";
import type { MileageRate } from "@/lib/reimbursements/money";
import type { LyftRow, WithAmounts } from "@/lib/reimbursements/server";
import ReimbursementForm from "./ReimbursementForm";
import { BUTTON, PRIMARY, ReimbursementDetail, StatusBadge } from "./shared";

const fileHref = (path: string) => `/api/reimbursements/file?path=${encodeURIComponent(path)}`;

export default function StaffReimbursements({
  reimbursements,
  lyft,
  rates,
  today,
}: {
  reimbursements: WithAmounts[];
  lyft: LyftRow[];
  rates: MileageRate[];
  today: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState<{ editing?: WithAmounts } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function remove(r: WithAmounts) {
    if (!window.confirm("Delete this Travel Reimbursement?")) return;
    setErr(null);
    const res = await fetch(`/api/reimbursements/${r.id}`, { method: "DELETE" });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(payload.error || "Could not delete it.");
    setFlash("Deleted.");
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Reimbursements</h1>
        <button className={PRIMARY} onClick={() => { setFlash(null); setForm({}); }}>
          New
        </button>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        One Travel Reimbursement per Reason: Groceries / errands, or one Catering Event. Mileage in your own car is paid at the IRS rate for the trip date, plus any tolls and parking, on your next paycheck once approved. A Lyft ride on the company card: upload the Lyft ride report instead.
      </p>
      {flash && <div className="text-sm text-emerald-700 dark:text-emerald-400">{flash}</div>}
      {err && <div className="text-sm text-rose-600 dark:text-rose-400">{err}</div>}

      {reimbursements.length === 0 && lyft.length === 0 && (
        <div className="text-sm text-slate-500">Nothing yet. Press New to add a Travel Reimbursement or a Lyft ride report.</div>
      )}

      {reimbursements.length > 0 && (
        <ul className="space-y-3">
          {reimbursements.map((r) => (
            <li key={r.id} className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <ReimbursementDetail r={r} fileHref={fileHref} />
                <StatusBadge status={r.status} />
              </div>
              {r.status === "rejected" && r.rejection_reason && (
                <div className="text-sm text-rose-700 dark:text-rose-400">Rejected: {r.rejection_reason}</div>
              )}
              {(r.status === "paid" || r.status === "paid_outside_payroll") && r.paid_on && (
                <div className="text-xs text-slate-500">Paid {r.paid_on}</div>
              )}
              {staffMayChange(r.status) && (
                <div className="flex gap-2">
                  <button className={BUTTON} onClick={() => { setFlash(null); setForm({ editing: r }); }}>
                    {r.status === "rejected" ? "Fix and resubmit" : "Edit"}
                  </button>
                  <button className={BUTTON} onClick={() => remove(r)}>
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {lyft.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Lyft ride reports</h2>
          <ul className="space-y-2">
            {lyft.map((l) => (
              <li key={l.id} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 flex items-start justify-between gap-3 text-sm">
                <div className="space-y-0.5 text-slate-700 dark:text-slate-300">
                  <div className="font-medium text-slate-900 dark:text-slate-100">{reasonLabel(l)}</div>
                  <div>Trip date {l.trip_date}</div>
                  <div className="flex flex-wrap gap-2">
                    {l.screenshot_paths.map((p, i) => (
                      <a key={p} href={fileHref(p)} target="_blank" rel="noreferrer" className="underline text-xs">
                        Screenshot {i + 1}
                      </a>
                    ))}
                  </div>
                </div>
                <StatusBadge status="filed" />
              </li>
            ))}
          </ul>
        </div>
      )}

      {form && (
        <Modal onClose={() => setForm(null)} className="max-w-lg">
          <ReimbursementForm
            rates={rates}
            today={today}
            editing={form.editing}
            onCancel={() => setForm(null)}
            onDone={(message) => {
              setForm(null);
              setFlash(message);
              router.refresh();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
