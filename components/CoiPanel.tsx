"use client";

import { useMemo, useState } from "react";
import type { Deal } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { fmtEasternDateTime } from "@/lib/dateFormat";
import {
  buildCoiRequest,
  coiStatus,
  daysUntil,
  easternToday,
  NAMED_INSURED,
  type CoiStatus,
} from "@/lib/coi";

// The Hartford's online Business Service Center. This is the login landing
// page only — the panel opens it in a new tab and stops there. It never
// submits a certificate request, never fills a credential: the human is at the
// send boundary by design (bj-finance #343 is a prototype; the mechanism is a
// review question). See the panel's Hartford note.
const HARTFORD_PORTAL_URL = "https://business.thehartford.com/";

const STATUS_UI: Record<
  CoiStatus,
  { label: string; box: string; dot: string }
> = {
  not_required: {
    label: "Not required",
    box: "border-slate-700 bg-slate-800/40 text-slate-300",
    dot: "bg-slate-500",
  },
  sent: {
    label: "Sent",
    box: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    dot: "bg-emerald-400",
  },
  needed: {
    label: "Needed",
    box: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    dot: "bg-amber-400",
  },
  needed_urgent: {
    label: "Needed — event soon",
    box: "border-rose-500/50 bg-rose-500/10 text-rose-200",
    dot: "bg-rose-400",
  },
};

/** One labelled value with its own copy button. */
function CopyRow({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure origin / no permission). The value is on
      // screen to read either way.
    }
  }
  return (
    <div className="py-1.5 border-b border-slate-800">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">
          {label}
        </span>
        {value && (
          <button
            type="button"
            onClick={copy}
            className="text-[11px] text-sky-300 underline underline-offset-2 hover:text-sky-200"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <div className="mt-0.5 text-sm text-slate-200 whitespace-pre-wrap break-words">
        {value ?? <span className="text-slate-500 italic">missing</span>}
      </div>
    </div>
  );
}

export default function CoiPanel({
  deal,
  onDealUpdate,
}: {
  deal: Deal;
  onDealUpdate?: (deal: Deal) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  const status = useMemo(() => coiStatus(deal), [deal]);
  const request = useMemo(() => buildCoiRequest(deal), [deal]);
  const dUntil = useMemo(
    () => daysUntil(deal.event_date, easternToday()),
    [deal.event_date],
  );

  // Deals that never need a COI don't get a panel at all — the drawer already
  // carries a lot, and a "Not required" box on every deal is noise.
  if (status === "not_required") return null;

  const ui = STATUS_UI[status];

  async function writeSentAt(value: string | null) {
    if (saving) return;
    // Clearing the stamp re-opens the prod conformance red for this deal, so
    // guard it behind a confirm — a mis-click must not silently un-send a COI.
    if (value === null && !confirm("Clear the COI-sent mark? This re-opens the conformance check for this deal.")) {
      return;
    }
    setSaving(true);
    setError(null);
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("deals")
      .update({ coi_sent_at: value, updated_at: now })
      .eq("id", deal.id);
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    onDealUpdate?.({ ...deal, coi_sent_at: value, updated_at: now });
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(request.fullText);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    } catch {
      /* clipboard blocked — the pack is on screen to read */
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Certificate of insurance
        </h3>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${ui.box}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${ui.dot}`} />
          {ui.label}
        </span>
      </div>

      {status === "sent" ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-sm text-emerald-100">
          COI marked sent{" "}
          {deal.coi_sent_at ? (
            <span className="text-emerald-300/90">
              on {fmtEasternDateTime(deal.coi_sent_at)}
            </span>
          ) : null}
          . This clears the prod conformance check{" "}
          <code className="text-[11px] text-emerald-300/80">
            revive.coi_required_unsent
          </code>{" "}
          for this deal.
          <button
            type="button"
            onClick={() => writeSentAt(null)}
            disabled={saving}
            className="ml-2 text-[11px] text-slate-400 underline underline-offset-2 hover:text-slate-200 disabled:opacity-50"
          >
            {saving ? "…" : "Undo"}
          </button>
        </div>
      ) : (
        <>
          <p className="text-xs text-slate-400 mb-2">
            {status === "needed_urgent" && dUntil !== null ? (
              <span className="text-rose-300">
                Event is {dUntil === 0 ? "today" : `in ${dUntil} day${dUntil === 1 ? "" : "s"}`}
                {" "}— the venue can refuse entry without proof of insurance.{" "}
              </span>
            ) : null}
            The fields below are the Hartford certificate request, pre-filled
            from this deal. Copy them into the Business Service Center, then mark
            it sent.
          </p>

          {request.missing.length > 0 && (
            <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Fill in on the deal before requesting: {request.missing.join(", ")}.
            </div>
          )}

          <div className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
            <CopyRow
              label="Certificate holder"
              value={request.certificateHolderName}
            />
            <CopyRow
              label="Holder address"
              value={request.certificateHolderAddress}
            />
            <CopyRow
              label="Additional insured"
              value={request.additionalInsured}
            />
            <CopyRow
              label="Description of operations / event"
              value={request.descriptionOfOperations}
            />
            <div className="pt-2 text-[11px] text-slate-500">
              Named insured: {NAMED_INSURED.legalName} (dba {NAMED_INSURED.dba}).{" "}
              {NAMED_INSURED.note}
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={copyAll}
              className="text-xs bg-sky-500/20 text-sky-100 border border-sky-500/40 rounded px-3 py-1.5 hover:bg-sky-500/30"
            >
              {copiedAll ? "Copied whole request" : "Copy whole request"}
            </button>
            <a
              href={HARTFORD_PORTAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs bg-slate-800 text-slate-200 border border-slate-700 rounded px-3 py-1.5 hover:bg-slate-700"
            >
              Open Hartford portal
            </a>
            <button
              type="button"
              onClick={() => writeSentAt(new Date().toISOString())}
              disabled={saving}
              className="text-xs bg-emerald-500/20 text-emerald-100 border border-emerald-500/40 rounded px-3 py-1.5 hover:bg-emerald-500/30 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Mark COI sent"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            The portal opens to its sign-in page only. Nothing is submitted or
            sent for you — you request the certificate and hit send.
          </p>
        </>
      )}

      {error && (
        <p className="mt-2 text-xs text-rose-300">Couldn’t save: {error}</p>
      )}
    </section>
  );
}
