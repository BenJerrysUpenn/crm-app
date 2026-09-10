"use client";

import { useState } from "react";
import Sheet from "./Sheet";
import {
  DISPOSITIONS,
  type CallDeskRow,
  type Disposition,
} from "@/lib/callDesk/types";

/** Stages a deal can still be lost from (mirrors the API route's check). */
const OPEN_STAGES = ["Open", "Sent Quote", "Quote Review"];

/**
 * "How did the call go?" — the outcome capture that makes the call log mean
 * anything. Opened automatically when the caller comes back to the tab after
 * tapping Call now, and reachable any time via "Log outcome".
 *
 * Closing without choosing does NOT resolve the call: the row keeps its red
 * badge and this sheet re-offers on the next focus.
 *
 * "Not now / lost (keep emailing)" (bj-finance #421) is the outcome for a
 * prospect who is simply not buying today: it takes them off the call queue
 * and deliberately leaves them on the marketing email list. When they have an
 * open deal, the sheet offers to close that as lost at the same time, through
 * the CRM's own stage-change path. It is NOT a stop request — that is "Do not
 * call", which is permanent and stops email too.
 *
 * The one way out is "I didn't call" (bj-finance #413) — a mis-tap on Call
 * now leaves a pending call that can never be answered honestly, so the log
 * row is removed instead. Only while it is still empty: once a recording is
 * attached the undo is gone, and the server checks the same thing.
 */
export default function DispositionSheet({
  row,
  eventId,
  canUndo = true,
  onClose,
  onSaved,
  onRemoved,
}: {
  row: CallDeskRow;
  eventId: number;
  /** False once a recording was attached to this call in this session. */
  canUndo?: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
  onRemoved: (message: string) => void;
}) {
  const [choice, setChoice] = useState<Disposition | null>(null);
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [confirmDnc, setConfirmDnc] = useState(false);
  const [closeDeal, setCloseDeal] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  // The deal this call could close, if any. Only a deal still in the working
  // pipeline can be lost; anything past that is already decided, and the
  // server re-checks the stage before it writes.
  const openDealId =
    row.last_deal_id && OPEN_STAGES.includes(row.last_deal_stage ?? "")
      ? row.last_deal_id
      : null;

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
    if (choice === "lost" && closeDeal && openDealId)
      body.close_deal_id = openDealId;

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
    if (choice === "do_not_call") {
      onSaved(`${row.name ?? "Prospect"} marked do not call — outreach stopped.`);
      return;
    }
    if (choice === "lost") {
      onSaved(
        closeDeal && openDealId
          ? `Marked lost and deal #${openDealId} closed. Still on the email list.`
          : "Marked lost. Still on the email list.",
      );
      return;
    }
    onSaved(`Logged: ${label}.`);
  }

  async function remove() {
    if (removing) return;
    setRemoving(true);
    setError(null);

    const res = await fetch(`/api/call-desk/calls/${eventId}`, {
      method: "DELETE",
    });
    setRemoving(false);

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      setError(payload.error || `Could not remove the call (${res.status})`);
      setConfirmRemove(false);
      return;
    }

    onRemoved("Call log removed.");
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

      {choice === "lost" && (
        <div className="mt-4 rounded-md border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-slate-300 space-y-2">
          {openDealId ? (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={closeDeal}
                onChange={(e) => setCloseDeal(e.target.checked)}
                className="mt-0.5 h-5 w-5 accent-slate-400 shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-slate-100">
                  Also close deal #{openDealId} as lost
                </span>
                <span className="block text-xs text-slate-400">
                  Currently {row.last_deal_stage}. Moves it to Closed Lost on
                  the board.
                </span>
              </span>
            </label>
          ) : null}
          <p className="text-xs text-slate-400">
            They stay on the marketing email list. To stop email as well, use
            “Do not call”.
          </p>
        </div>
      )}

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

      {canUndo && (
        <div className="mt-4 pt-4 border-t border-slate-800">
          {confirmRemove ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-rose-200 mr-auto">
                Remove the call log?
              </span>
              <button
                type="button"
                onClick={() => setConfirmRemove(false)}
                disabled={removing}
                className="min-h-[44px] px-4 text-sm rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
              >
                Keep
              </button>
              <button
                type="button"
                onClick={remove}
                disabled={removing}
                className="min-h-[44px] px-4 text-sm font-medium rounded-md bg-rose-600 hover:bg-rose-500 text-white border border-rose-500 disabled:opacity-40"
              >
                {removing ? "Removing…" : "Remove"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              className="min-h-[44px] w-full text-sm text-rose-300 hover:text-rose-200 underline underline-offset-2"
            >
              I didn&apos;t call — remove this
            </button>
          )}
        </div>
      )}

      <p className="mt-3 text-xs text-slate-500">
        Tapping “Later” leaves this call flagged. It will keep asking.
      </p>
    </Sheet>
  );
}
