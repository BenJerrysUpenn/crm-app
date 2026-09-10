"use client";

import { useState } from "react";
import Sheet from "./Sheet";
import type { CallDeskRow } from "@/lib/callDesk/types";

/**
 * Append-only prospect notes. The running log is read-only and shown newest
 * last, the way the deals drawer shows its activity log — nothing already
 * written can be edited away from this screen.
 */
export default function NoteSheet({
  row,
  onClose,
  onAppended,
}: {
  row: CallDeskRow;
  onClose: () => void;
  onAppended: (notes: string) => void;
}) {
  const [notes, setNotes] = useState(row.notes ?? "");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function append() {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    setError(null);

    const res = await fetch(
      `/api/call-desk/prospects/${row.prospect_id}/notes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body }),
      },
    );
    setSaving(false);

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      setError(payload.error || `Could not save the note (${res.status})`);
      return;
    }
    const payload = await res.json();
    const next = (payload.notes as string) ?? "";
    setNotes(next);
    setText("");
    onAppended(next);
  }

  return (
    <Sheet
      title="Notes"
      subtitle={[row.name, row.company].filter(Boolean).join(" · ")}
      onClose={onClose}
    >
      <div className="rounded-md border border-slate-800 bg-slate-950 px-3 py-3 max-h-56 overflow-y-auto">
        {notes.trim() ? (
          <pre className="whitespace-pre-wrap break-words text-xs text-slate-300 font-sans">
            {notes}
          </pre>
        ) : (
          <p className="text-xs text-slate-500">No notes yet.</p>
        )}
      </div>

      <label className="block mt-4">
        <span className="block text-xs text-slate-400 mb-1">Add a note</span>
        <textarea
          rows={3}
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Appended with the date and your name. Never overwritten."
          className="w-full text-sm bg-slate-800 border border-slate-700 text-slate-100 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
      </label>

      {error && (
        <div className="mt-3 rounded-md border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="min-h-[44px] px-4 text-sm bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md border border-slate-700"
        >
          Done
        </button>
        <button
          type="button"
          onClick={append}
          disabled={!text.trim() || saving}
          className="flex-1 min-h-[44px] text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-md border border-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Append note"}
        </button>
      </div>
    </Sheet>
  );
}
