"use client";

// One undo history for the whole app (lib/undo.ts), and the bar that shows it.
//
// A screen calls useUndo().record({ label, undo, redo }) after a write that
// cannot simply be clicked back. The bar at the bottom of the screen then
// says what was done, with Undo; after an undo it offers Redo. Ctrl+Z / Cmd+Z
// undoes and Ctrl+Shift+Z / Cmd+Shift+Z (or Ctrl+Y) redoes, except while
// typing in a field, where those keys belong to the field.
//
// After every undo or redo the page reloads its data (router.refresh), as
// after any other save.

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { UndoHistory, type UndoEntry } from "@/lib/undo";

type UndoApi = { record: (entry: UndoEntry) => void };

const UndoContext = createContext<UndoApi>({ record: () => {} });

export function useUndo(): UndoApi {
  return useContext(UndoContext);
}

function typingInAField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export default function UndoProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [history] = useState(() => new UndoHistory());
  const state = useSyncExternalStore(
    (fn) => history.subscribe(fn),
    () => history.getState(),
    () => history.getState(),
  );
  const api = useMemo<UndoApi>(() => ({ record: (e) => history.record(e) }), [history]);

  async function undo() {
    if (await history.undo()) router.refresh();
  }
  async function redo() {
    if (await history.redo()) router.refresh();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || typingInAField(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        void history.undo().then((ok) => ok && router.refresh());
      } else if ((k === "z" && e.shiftKey) || (k === "y" && !e.shiftKey)) {
        e.preventDefault();
        void history.redo().then((ok) => ok && router.refresh());
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [history, router]);

  const { last, undoLabel, redoLabel, busy } = state;
  const message =
    last === null
      ? null
      : last.kind === "did"
        ? last.label
        : last.kind === "undid"
          ? `Undone: ${last.label}`
          : last.kind === "redid"
            ? `Redone: ${last.label}`
            : `Couldn't change "${last.label}": ${last.error}`;

  return (
    <UndoContext.Provider value={api}>
      {children}
      {(undoLabel !== null || redoLabel !== null) && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-2rem)] flex items-center gap-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg px-3 py-2 text-sm"
        >
          {message && (
            <span className={`truncate ${last?.kind === "failed" ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-200"}`}>
              {message}
            </span>
          )}
          {undoLabel !== null && (
            <button
              onClick={undo}
              disabled={busy}
              title={`Undo: ${undoLabel}`}
              className="shrink-0 px-2 py-0.5 rounded-md border border-slate-300 dark:border-slate-600 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? "…" : "Undo"}
            </button>
          )}
          {redoLabel !== null && (
            <button
              onClick={redo}
              disabled={busy}
              title={`Redo: ${redoLabel}`}
              className="shrink-0 px-2 py-0.5 rounded-md border border-slate-300 dark:border-slate-600 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              Redo
            </button>
          )}
          {message && (
            <button onClick={() => history.dismiss()} aria-label="Hide message" className="shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
              ×
            </button>
          )}
        </div>
      )}
    </UndoContext.Provider>
  );
}
