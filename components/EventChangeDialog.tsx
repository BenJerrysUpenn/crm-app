"use client";

import { useEffect, useState } from "react";
import {
  confirmationLines,
  describeWhen,
  interpretChangeResponse,
  staffedShiftIds,
  type EventChangeBody,
  type EventChangeOutcome,
  type EventPreview,
} from "@/lib/eventChange";

// The Reschedule event / Cancel event dialog on the deal drawer. It reads the
// event and its crew from GET /api/deals/:id/event-change, names everyone with
// a shift before anything is confirmed, and POSTs the change. Every rule is in
// lib/eventChange.ts (confirmationLines included); nothing is sent from here.

// Which dialog is open is the action it POSTs.
export type EventChangeMode = EventChangeBody["action"];

const INPUT =
  "bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 disabled:opacity-40";

export default function EventChangeDialog({
  dealId,
  mode,
  onClose,
  onDone,
}: {
  dealId: number;
  mode: EventChangeMode;
  onClose: () => void;
  /**
   * Called once the deal has changed: with the note line it appended, or with
   * the error when the deal was saved but a later step was not.
   */
  onDone: (outcome: EventChangeOutcome) => void;
}) {
  const [preview, setPreview] = useState<EventPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [date, setDate] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [dateNotSet, setDateNotSet] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/deals/${dealId}/event-change`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error || `HTTP ${res.status}`);
          return;
        }
        const p = body as EventPreview;
        setPreview(p);
        setDate(p.deal.event_date ?? "");
        setStart(p.deal.event_start_time ?? "");
        setEnd(p.deal.event_end_time ?? "");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  async function confirm() {
    if (!preview || submitting) return;
    setError(null);
    setSubmitting(true);
    const staffed_shift_ids = staffedShiftIds(preview.shifts);
    const body: EventChangeBody =
      mode === "cancel"
        ? { action: "cancel", staffed_shift_ids }
        : dateNotSet
        ? { action: "reschedule", date_not_set: true, staffed_shift_ids }
        : {
            action: "reschedule",
            event_date: date,
            event_start_time: start,
            event_end_time: end,
            staffed_shift_ids,
          };
    try {
      const res = await fetch(`/api/deals/${dealId}/event-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      // A 2xx, or a partial failure that still changed the deal, closes the
      // dialog and lets the drawer re-read it; any other failure stays here.
      const result = interpretChangeResponse(res.ok, res.status, out);
      if (result.done) {
        onDone(result.outcome);
        return;
      }
      setError(result.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  const title = mode === "cancel" ? "Cancel event" : "Reschedule event";
  const confirmLabel = mode === "cancel" ? "Cancel the event" : dateNotSet ? "Clear the date" : "Reschedule";
  const lines = preview ? confirmationLines(preview, mode, dateNotSet) : [];
  const ready =
    preview !== null &&
    preview.deal.can_change &&
    (mode === "cancel" || dateNotSet || (date !== "" && start !== "" && end !== ""));

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-lg p-4 sm:p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        {!preview && !error && <div className="text-sm text-slate-400">Loading the event and its crew…</div>}
        {preview && !preview.deal.can_change && (
          <div className="text-sm text-amber-200">This deal is at {preview.deal.stage}; only booked events can be changed here.</div>
        )}
        {preview && (
          <div className="space-y-3 text-sm text-slate-200">
            <div className="text-slate-400">
              Now:{" "}
              <span className="text-slate-200">
                {describeWhen(preview.deal.event_date, preview.deal.event_start_time, preview.deal.event_end_time)}
              </span>
            </div>
            {mode === "reschedule" && (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-500">New date</span>
                    <input type="date" className={INPUT} value={date} disabled={dateNotSet} onChange={(e) => setDate(e.target.value)} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-500">Start time</span>
                    <input type="time" className={INPUT} value={start} disabled={dateNotSet} onChange={(e) => setStart(e.target.value)} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-slate-500">End time</span>
                    <input type="time" className={INPUT} value={end} disabled={dateNotSet} onChange={(e) => setEnd(e.target.value)} />
                  </label>
                </div>
                <label className="flex items-center gap-2 text-slate-300">
                  <input type="checkbox" checked={dateNotSet} onChange={(e) => setDateNotSet(e.target.checked)} />
                  Date not set yet
                </label>
              </div>
            )}
            {lines.length > 0 && (
              <ul className="list-disc pl-5 space-y-1 text-slate-300">
                {lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <div className="text-sm text-rose-200 bg-rose-950 border border-rose-900 rounded px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200 px-3 py-1.5">
            Close
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!ready || submitting}
            className={`text-sm rounded-md px-3 py-1.5 border disabled:opacity-40 disabled:cursor-not-allowed ${
              mode === "cancel"
                ? "bg-rose-500/20 text-rose-200 border-rose-500/40 hover:bg-rose-500/30"
                : "bg-sky-500/20 text-sky-200 border-sky-500/40 hover:bg-sky-500/30"
            }`}
          >
            {submitting ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
