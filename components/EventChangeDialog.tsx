"use client";

import { useEffect, useState } from "react";
import { describeShiftTime, describeWhen, money, type CrewShift } from "@/lib/eventChange";

// The Reschedule event / Cancel event dialog on the deal drawer. It reads the
// event and its crew from GET /api/deals/:id/event-change, names everyone with
// a shift before anything is confirmed, and POSTs the change. Every rule is in
// lib/eventChange.ts; nothing is sent to anyone from here.

export type EventChangeMode = "reschedule" | "cancel";

export type EventPreview = {
  deal: {
    id: number;
    stage: string;
    can_change: boolean;
    event_date: string | null;
    event_start_time: string | null;
    event_end_time: string | null;
    amount_paid: number | null;
    has_calendar_event: boolean;
  };
  shifts: CrewShift[];
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the dialog says will happen to the crew and the money. Pure. */
export function confirmationLines(
  preview: EventPreview,
  mode: EventChangeMode,
  dateNotSet: boolean,
): string[] {
  const staffed = preview.shifts.filter((s) => s.employee_id);
  const open = preview.shifts.length - staffed.length;
  const people = staffed
    .map((s) => `${s.person ?? "Unnamed person"} (${describeShiftTime(s.starts_at, s.ends_at)})`)
    .join(", ");
  const lines: string[] = [];

  if (mode === "cancel") {
    lines.push("The deal moves to Closed Lost and its calendar event is deleted.");
    if (staffed.length) lines.push(`On the crew: ${people}. Their shifts are removed. Tell them yourself; nothing is sent.`);
    if (open) lines.push(`${plural(open, "open shift is", "open shifts are")} removed.`);
    const paid = preview.deal.amount_paid;
    if (typeof paid === "number" && paid > 0) {
      lines.push(`Paid ${money(paid)}. Any refund is done by hand in Square.`);
    }
    return lines;
  }

  if (dateNotSet) {
    lines.push("The date is cleared and the calendar event is deleted.");
    if (staffed.length) lines.push(`On the crew: ${people}. Their shifts are removed. Tell them yourself; nothing is sent.`);
    if (open) lines.push(`${plural(open, "open shift is", "open shifts are")} removed.`);
    return lines;
  }

  if (!preview.deal.event_date && preview.shifts.length) {
    lines.push(
      `The deal has no date to move its shifts from, so ${plural(preview.shifts.length, "shift stays", "shifts stay")} where ${preview.shifts.length === 1 ? "it is" : "they are"}${staffed.length ? ` (${people})` : ""}.`,
    );
    return lines;
  }
  if (staffed.length) lines.push(`On the crew: ${people}. Their shifts move with the event. Tell them yourself; nothing is sent.`);
  if (open) lines.push(`${plural(open, "open shift moves", "open shifts move")} with it.`);
  return lines;
}

const INPUT =
  "bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 disabled:opacity-40";

/** The dialog's body for a loaded preview. Presentational: the container owns the state. */
export function EventChangeForm({
  preview,
  mode,
  date,
  start,
  end,
  dateNotSet,
  onDate,
  onStart,
  onEnd,
  onDateNotSet,
}: {
  preview: EventPreview;
  mode: EventChangeMode;
  date: string;
  start: string;
  end: string;
  dateNotSet: boolean;
  onDate: (v: string) => void;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
  onDateNotSet: (v: boolean) => void;
}) {
  const d = preview.deal;
  const lines = confirmationLines(preview, mode, dateNotSet);
  return (
    <div className="space-y-3 text-sm text-slate-200">
      <div className="text-slate-400">
        Now: <span className="text-slate-200">{describeWhen(d.event_date, d.event_start_time, d.event_end_time)}</span>
      </div>
      {mode === "reschedule" && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">New date</span>
              <input type="date" className={INPUT} value={date} disabled={dateNotSet} onChange={(e) => onDate(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">Start time</span>
              <input type="time" className={INPUT} value={start} disabled={dateNotSet} onChange={(e) => onStart(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">End time</span>
              <input type="time" className={INPUT} value={end} disabled={dateNotSet} onChange={(e) => onEnd(e.target.value)} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-slate-300">
            <input type="checkbox" checked={dateNotSet} onChange={(e) => onDateNotSet(e.target.checked)} />
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
  );
}

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
  onDone: (outcome: { noteLine?: string; error?: string }) => void;
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
    const staffed_shift_ids = preview.shifts.filter((s) => s.employee_id).map((s) => s.id);
    const body =
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
      if (!res.ok) {
        // A partial failure still changed the deal: the drawer refreshes it
        // and keeps the message.
        if (res.status === 500 && typeof out.error === "string" && out.error.startsWith("The deal was saved")) {
          onDone({ error: out.error });
          return;
        }
        setError(out.error || `HTTP ${res.status}`);
        return;
      }
      onDone({ noteLine: typeof out.noteLine === "string" ? out.noteLine : undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  const title = mode === "cancel" ? "Cancel event" : "Reschedule event";
  const confirmLabel = mode === "cancel" ? "Cancel the event" : dateNotSet ? "Clear the date" : "Reschedule";
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
          <EventChangeForm
            preview={preview}
            mode={mode}
            date={date}
            start={start}
            end={end}
            dateNotSet={dateNotSet}
            onDate={setDate}
            onStart={setStart}
            onEnd={setEnd}
            onDateNotSet={setDateNotSet}
          />
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
