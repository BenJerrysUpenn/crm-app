"use client";

// Pieces both Reimbursements pages use (bj-finance #210): uploading a file to
// the private bucket through a signed URL, a preview of what was picked, the
// status badge, and one reimbursement's money laid out the same way for staff
// and Approvers, an adjusted amount reading old -> new (ruling 40).

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { money } from "@/lib/payroll/paySheet";
import { FIELD_LABEL, STATUS_LABEL, type ReimbursementStatus } from "@/lib/reimbursements/lifecycle";
import { reasonLabel } from "@/lib/reimbursements/events";
import { BUCKET, contentTypeOf, extOf } from "@/lib/reimbursements/submission";
import { amountText, totalText } from "@/lib/reimbursements/money";
import { routeEnds, routeText } from "@/lib/reimbursements/routeMiles";
import type { WithAmounts } from "@/lib/reimbursements/server";

export const INPUT =
  "mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-slate-900 dark:text-slate-100";
export const BUTTON =
  "text-sm px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";
export const PRIMARY =
  "text-sm px-3 py-1.5 rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium disabled:opacity-50";

/** Opening one of the staff member's own files, through the time site's signed file route. */
export const staffFileHref = (path: string) => `/api/reimbursements/file?path=${encodeURIComponent(path)}`;

/**
 * Uploads one file: asks `endpoint` for a signed upload URL (the server makes
 * the path), uploads straight to Storage, and returns the path to send with
 * the form. Phone photos never pass through Vercel.
 */
export async function uploadFile(endpoint: string, extra: Record<string, unknown>, file: File): Promise<string> {
  const ext = extOf(file.name);
  const contentType = contentTypeOf(file.name, file.type);
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

/** A file picked in the form: its name, size and type, and a local URL to show it. */
export type PickedFile = { path: string; name: string; size: number | null; type: string; url: string | null };

function sizeText(bytes: number | null): string {
  if (bytes == null) return "";
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileThumb({ f }: { f: PickedFile }) {
  const [broken, setBroken] = useState(false);
  const box = "h-16 w-16 shrink-0 rounded-md border border-slate-300 dark:border-slate-700";
  if (f.type.startsWith("image/") && f.url && !broken)
    // A local blob URL or the signed file route: next/image cannot optimise either.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={f.url} alt={f.name} onError={() => setBroken(true)} className={`${box} object-cover bg-slate-100 dark:bg-slate-800`} />;
  return (
    <div className={`${box} flex items-center justify-center bg-slate-100 dark:bg-slate-800 text-xs font-semibold ${f.type === "application/pdf" ? "text-rose-700 dark:text-rose-400" : "text-slate-500"}`}>
      {f.type === "application/pdf" ? "PDF" : "File"}
    </div>
  );
}

/**
 * What was picked, before submitting (ruling 44): a thumbnail for a photo, a
 * PDF badge otherwise (and for a photo the browser cannot show, e.g. HEIC on
 * Chrome), with the file name and size, so staff can tell it is the right one.
 */
export function FilePreviews({ files, noun, onRemove }: { files: PickedFile[]; noun: string; onRemove: (path: string) => void }) {
  if (!files.length) return null;
  return (
    <ul className="space-y-2">
      {files.map((f, i) => (
        <li key={f.path} className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300">
          {f.url ? (
            <a href={f.url} target="_blank" rel="noreferrer" title="Open it">
              <FileThumb f={f} />
            </a>
          ) : (
            <FileThumb f={f} />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate">{f.name || `${noun} ${i + 1}`}</div>
            {f.size != null && <div className="text-xs text-slate-500">{sizeText(f.size)}</div>}
          </div>
          <button type="button" className="text-xs underline" onClick={() => onRemove(f.path)}>
            remove
          </button>
        </li>
      ))}
    </ul>
  );
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
  const adjusted = r.before_adjustments?.adjusted ?? [];
  return (
    <div className="space-y-1 text-sm text-slate-700 dark:text-slate-300">
      <div className="font-medium text-slate-900 dark:text-slate-100">{reasonLabel(r)}</div>
      <div>Trip date {r.trip_date}</div>
      {(miles > 0 || r.mileage_cents_override != null) && (
        <div>
          Mileage: {miles.toFixed(1)} mi
          {r.mileage_mode === "destinations" && r.stops?.length
            ? ` (${routeText(r.stops, routeEnds(r))})`
            : ""}
          {" × "}
          {rateText(a.rate)} = {amountText(r, "mileage")}
        </div>
      )}
      {(a.tolls_cents > 0 || adjusted.includes("tolls")) && <div>Tolls: {amountText(r, "tolls")}</div>}
      {(a.parking_cents > 0 || adjusted.includes("parking")) && <div>Parking: {amountText(r, "parking")}</div>}
      <div className="font-medium text-slate-900 dark:text-slate-100">
        Total {totalText(r)}
      </div>
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
