"use client";

import { useState } from "react";
import Sheet from "./Sheet";
import {
  DISPOSITIONS,
  type CallDeskRow,
  type Disposition,
} from "@/lib/callDesk/types";

/**
 * "How did the call go?" — the outcome capture that makes the call log mean
 * anything. Opened automatically when the caller comes back to the tab after
 * tapping Call now, and reachable any time via "Log outcome".
 *
 * Closing without choosing does NOT resolve the call: the row keeps its red
 * badge and this sheet re-offers on the next focus.
 */
export default function DispositionSheet({
  row,
  eventId,
  onClose,
  onSaved,
}: {
  row: CallDeskRow;
  eventId: number;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [choice, setChoice] = useState<Disposition | null>(null);
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [confirmDnc, setConfirmDnc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!choice || saving) return;
    // Do-not-call stops email as well as calls, so it needs a second tap.
    if (choice === "do_not_call" && !confirmDnc) {
      setConfirmDnc(true);
      return;
    }

    setSaving(true);
    setError(null);

    const body: Record<string, unknown> = { disposition: choice };
    const mins = Number(minutes);
    if (minutes.trim() !== "" && Number.isFinite(mins) && mins >= 0) {
      body.duration_seconds = Math.round(mins * 60);
    }
    if (note.trim()) body.note = note.trim();

    const res = await fetch(`/api/call-desk/calls/${eventId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      setError(payload.error || `Save failed (${res.status})`);
      return;
    }

    const label =
      DISPOSITIONS.find((d) => d.value === choice)?.label ?? choice;
    onSaved(
      choice === "do_not_call"
        ? `${row.name ?? "Prospect"} marked do not call — outreach stopped.`
        : `Logged: ${label}.`,
    );
  }

  return (
    <Sheet
      title="How did the call go?"
      subtitle={[row.name, row.company].filter(Boolean).join(" · ")}
      onClose={onClose}
    >
      <fieldset className="space-y-2">
        <legend className="sr-only">Disposition</legend>
        {DISPOSITIONS.map((d) => {
          const selected = choice === d.value;
          const danger = d.value === "do_not_call";
          return (
            <label
              key={d.value}
              className={`flex items-start gap-3 min-h-[56px] px-3 py-3 rounded-md border cursor-pointer transition ${
                selected
                  ? danger
                    ? "bg-rose-950 border-rose-700"
                    : "bg-slate-800 border-slate-500"
                  : "bg-slate-900 border-slate-700 hover:border-slate-600"
              }`}
            >
              <input
                type="radio"
                name="disposition"
                value={d.value}
                checked={selected}
                onChange={() => {
                  setChoice(d.value);
                  setConfirmDnc(false);
                }}
                className="mt-1 h-5 w-5 accent-slate-400 shrink-0"
              />
              <span className="min-w-0">
                <span
                  className={`block text-sm font-medium ${
                    danger ? "text-rose-200" : "text-slate-100"
                  }`}
                >
                  {d.label}
                </span>
                <span className="block text-xs text-slate-400">
                  {d.description}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="block text-xs text-slate-400 mb-1">
            Length (minutes, optional)
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="e.g. 4"
            className="w-full min-h-[44px] text-sm bg-slate-800 border border-slate-700 text-slate-100 rounded px-3 focus:outline-none focus:ring-2 focus:ring-slate-500"
          />
        </label>

        <label className="block">
          <span className="block text-xs text-slate-400 mb-1">
            Note (optional — also appended to this prospect&apos;s notes)
          </span>
          <textarea
            rows={3}
            maxLength={4000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What they said, what to do next…"
            className="w-full text-sm bg-slate-800 border border-slate-700 text-slate-100 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-500"
          />
        </label>
      </div>

      {confirmDnc && (
        <div className="mt-4 rounded-md border border-rose-800 bg-rose-950/60 px-3 py-3 text-sm text-rose-200">
          Stop all outreach to this person? This also stops emails and removes
          them from the queue. Tap “Save outcome” again to confirm.
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-md border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="min-h-[44px] px-4 text-sm bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md border border-slate-700"
        >
          Later
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!choice || saving}
          className={`flex-1 min-h-[44px] text-sm font-medium rounded-md border disabled:opacity-40 disabled:cursor-not-allowed ${
            choice === "do_not_call"
              ? "bg-rose-600 hover:bg-rose-500 text-white border-rose-500"
              : "bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500"
          }`}
        >
          {saving
            ? "Saving…"
            : confirmDnc
              ? "Save outcome — confirm"
              : "Save outcome"}
        </button>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Tapping “Later” leaves this call flagged. It will keep asking.
      </p>
    </Sheet>
  );
}
