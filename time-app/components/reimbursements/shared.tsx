"use client";

// Pieces both Reimbursements pages use (bj-finance #210): uploading a file to
// the private bucket through a signed URL, the status badge, and one
// reimbursement's money laid out the same way for staff and Approvers.

import { createClient } from "@/lib/supabase/client";
import { money } from "@/lib/payroll/paySheet";
import { FIELD_LABEL, STATUS_LABEL, type ReimbursementStatus } from "@/lib/reimbursements/lifecycle";
import { reasonLabel } from "@/lib/reimbursements/events";
import { BUCKET, CONTENT_TYPE_BY_EXT } from "@/lib/reimbursements/submission";
import type { WithAmounts } from "@/lib/reimbursements/server";

export const INPUT =
  "mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-slate-900 dark:text-slate-100";
export const BUTTON =
  "text-sm px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";
export const PRIMARY =
  "text-sm px-3 py-1.5 rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium disabled:opacity-50";

/**
 * Uploads one file: asks `endpoint` for a signed upload URL (the server makes
 * the path), uploads straight to Storage, and returns the path to send with
 * the form. Phone photos never pass through Vercel.
 */
export async function uploadFile(endpoint: string, extra: Record<string, unknown>, file: File): Promise<string> {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const contentType = file.type || CONTENT_TYPE_BY_EXT[ext] || "";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...extra, ext, content_type: contentType }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `Upload refused (${res.status})`);
  const { error } = await createClient().storage.from(BUCKET).uploadToSignedUrl(payload.path, payload.token, file, {
    contentType: contentType || undefined,
  });
  if (error) throw new Error(error.message);
  return payload.path as string;
}

const TONE: Record<ReimbursementStatus | "filed", string> = {
  submitted: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  approved: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
  rejected: "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300",
  paid: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  paid_outside_payroll: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  filed: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
};

export function StatusBadge({ status }: { status: ReimbursementStatus | "filed" }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${TONE[status]}`}>
      {status === "filed" ? "Filed" : STATUS_LABEL[status]}
    </span>
  );
}

function rateText(rate: number | null): string {
  return rate == null ? "no Mileage rate" : `${Number.isInteger(rate) ? rate : rate.toFixed(1)}¢/mi`;
}

/** Reason, trip date, Mileage, tolls, parking, total and Adjustments, as one block. */
export function ReimbursementDetail({
  r,
  fileHref,
  evidence = false,
}: {
  r: WithAmounts;
  fileHref: (path: string) => string;
  /** Link each Adjustment's evidence: the Approver's view only (staff cannot open it). */
  evidence?: boolean;
}) {
  const a = r.amounts;
  const miles = Number(r.miles);
  return (
    <div className="space-y-1 text-sm text-slate-700 dark:text-slate-300">
      <div className="font-medium text-slate-900 dark:text-slate-100">{reasonLabel(r)}</div>
      <div>Trip date {r.trip_date}</div>
      {(miles > 0 || r.mileage_cents_override != null) && (
        <div>
          Mileage: {miles.toFixed(1)} mi
          {r.mileage_mode === "destinations" && r.stops?.length ? ` (store → ${r.stops.join(" → ")}${r.return_to_start ? " → store" : ""})` : ""}
          {" × "}
          {rateText(a.rate)} = {money(a.mileage_cents)}
          {r.mileage_cents_override != null && " (adjusted)"}
        </div>
      )}
      {a.tolls_cents > 0 && <div>Tolls: {money(a.tolls_cents)}</div>}
      {a.parking_cents > 0 && <div>Parking: {money(a.parking_cents)}</div>}
      <div className="font-medium text-slate-900 dark:text-slate-100">Total {money(a.total_cents)}</div>
      {r.receipt_paths.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {r.receipt_paths.map((p, i) => (
            <a key={p} href={fileHref(p)} target="_blank" rel="noreferrer" className="underline text-xs">
              Receipt {i + 1}
            </a>
          ))}
        </div>
      ) : (
        (a.tolls_cents > 0 || a.parking_cents > 0) && <div className="text-xs text-amber-700 dark:text-amber-400">No receipt (confirmed when submitted)</div>
      )}
      {r.adjustments.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs">
          {r.adjustments.map((x) => (
            <li key={x.id}>
              Adjustment: {FIELD_LABEL[x.field]} {money(x.old_cents)} → {money(x.new_cents)}. {x.note}
              {evidence && (
                <>
                  {" "}
                  <a href={fileHref(x.evidence_path)} target="_blank" rel="noreferrer" className="underline">
                    Evidence
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
