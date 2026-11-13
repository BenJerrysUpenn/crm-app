// Undo and redo for writes made from the app's screens.
//
// Alina copied last week's schedule by mistake (2026-11-12) and there was no
// way back short of deleting 13 shifts one by one. Every write a screen makes
// that cannot simply be clicked back (a delete, a bulk write, an edit whose old
// values you would have to remember) now records an entry here: what to call
// to take it back, and what to call to do it again.
//
// The history lives in the open tab (components/UndoProvider.tsx keeps one for
// the whole app, so moving between pages keeps it). It is the steps to take,
// not the data: every step goes through the same API routes a person's click
// does, with the same checks and the same messages to staff. Reloading the
// page clears it.
//
// A step that fails stays where it was, so it can be tried again, and the
// error is shown. A new action clears what could be redone, as in any editor.

export type UndoEntry = {
  /** What was done, in the words the screen used: "Copied 13 shifts from last week". */
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
};

export type UndoState = {
  /** The label of the step Undo would take back, or null. */
  undoLabel: string | null;
  /** The label of the step Redo would do again, or null. */
  redoLabel: string | null;
  busy: boolean;
  /** What happened last: shown in the bar until the next step. */
  last: { kind: "did" | "undid" | "redid" | "failed"; label: string; error?: string } | null;
};

/** How many steps back the history keeps. */
export const UNDO_LIMIT = 50;

export class UndoHistory {
  private past: UndoEntry[] = [];
  private future: UndoEntry[] = [];
  private busy = false;
  private last: UndoState["last"] = null;
  private listeners = new Set<() => void>();
  private snapshot: UndoState = this.compute();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The current state. The same object until something changes (useSyncExternalStore). */
  getState(): UndoState {
    return this.snapshot;
  }

  /** A write just succeeded: it is the step Undo takes back. Clears Redo. */
  record(entry: UndoEntry): void {
    this.past.push(entry);
    if (this.past.length > UNDO_LIMIT) this.past.shift();
    this.future = [];
    this.last = { kind: "did", label: entry.label };
    this.changed();
  }

  /** Take back the latest step. False when there was nothing to do or it failed. */
  async undo(): Promise<boolean> {
    return this.step(this.past, this.future, "undo", "undid");
  }

  /** Do again the step last undone. False when there was nothing to do or it failed. */
  async redo(): Promise<boolean> {
    return this.step(this.future, this.past, "redo", "redid");
  }

  /** Forget the bar's message; the history stays. */
  dismiss(): void {
    this.last = null;
    this.changed();
  }

  private async step(from: UndoEntry[], to: UndoEntry[], run: "undo" | "redo", kind: "undid" | "redid"): Promise<boolean> {
    if (this.busy) return false;
    const entry = from.pop();
    if (!entry) return false;
    this.busy = true;
    this.changed();
    try {
      await entry[run]();
      to.push(entry);
      this.last = { kind, label: entry.label };
      return true;
    } catch (e) {
      // Leave it where it was so it can be tried again.
      from.push(entry);
      this.last = { kind: "failed", label: entry.label, error: (e as Error)?.message || "Something went wrong." };
      return false;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  private compute(): UndoState {
    return {
      undoLabel: this.past.at(-1)?.label ?? null,
      redoLabel: this.future.at(-1)?.label ?? null,
      busy: this.busy,
      last: this.last,
    };
  }

  private changed(): void {
    this.snapshot = this.compute();
    for (const fn of this.listeners) fn();
  }
}

/**
 * fetch for an undo or redo step: throws the route's own error when it refuses,
 * so the step stays put and the bar says why. Returns the parsed JSON body.
 */
export async function send<T = Record<string, unknown>>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(typeof j.error === "string" ? j.error : `Request failed (${res.status}).`);
  return j;
}

/** Run steps one after another, so a list of deletes stops at the first refusal. */
export async function each<T>(items: readonly T[], fn: (item: T) => Promise<unknown>): Promise<void> {
  for (const item of items) await fn(item);
}
