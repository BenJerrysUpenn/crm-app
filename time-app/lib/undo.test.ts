// The undo history (lib/undo.ts): the steps Undo and Redo take on the app's
// screens. Pure logic; the screens' own steps go through the API routes and
// are covered by the route tests (lib/undoRoutes.test.ts, lib/shiftNotice.test.ts).
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { UNDO_LIMIT, UndoHistory, type UndoEntry } from "./undo.ts";

// An entry that writes "undo X" / "redo X" to a log, failing when told to.
function entry(label: string, log: string[], fail: { undo?: boolean; redo?: boolean } = {}): UndoEntry {
  return {
    label,
    undo: async () => {
      if (fail.undo) throw new Error("server said no");
      log.push(`undo ${label}`);
    },
    redo: async () => {
      if (fail.redo) throw new Error("server said no");
      log.push(`redo ${label}`);
    },
  };
}

test("undo takes back the latest step first; redo does them again in order", async () => {
  const h = new UndoHistory();
  const log: string[] = [];
  h.record(entry("A", log));
  h.record(entry("B", log));
  assert.equal(h.getState().undoLabel, "B");

  assert.equal(await h.undo(), true);
  assert.equal(await h.undo(), true);
  assert.equal(await h.undo(), false, "nothing left to undo");
  assert.deepEqual(log, ["undo B", "undo A"]);
  assert.equal(h.getState().redoLabel, "A");

  assert.equal(await h.redo(), true);
  assert.equal(await h.redo(), true);
  assert.equal(await h.redo(), false, "nothing left to redo");
  assert.deepEqual(log, ["undo B", "undo A", "redo A", "redo B"]);
  assert.deepEqual(h.getState().last, { kind: "redid", label: "B" });
});

test("a new step after an undo clears what could be redone", async () => {
  const h = new UndoHistory();
  const log: string[] = [];
  h.record(entry("A", log));
  await h.undo();
  h.record(entry("C", log));
  assert.equal(h.getState().redoLabel, null);
  assert.equal(h.getState().undoLabel, "C");
});

test("a step that fails stays put, says why, and can be tried again", async () => {
  const h = new UndoHistory();
  const log: string[] = [];
  const flaky = { undo: true };
  h.record(entry("Copied 13 shifts from last week", log, flaky));

  assert.equal(await h.undo(), false);
  assert.equal(h.getState().undoLabel, "Copied 13 shifts from last week");
  assert.equal(h.getState().redoLabel, null);
  assert.deepEqual(h.getState().last, { kind: "failed", label: "Copied 13 shifts from last week", error: "server said no" });

  flaky.undo = false;
  assert.equal(await h.undo(), true);
  assert.deepEqual(log, ["undo Copied 13 shifts from last week"]);
});

test("one step at a time: a second undo while the first runs does nothing", async () => {
  const h = new UndoHistory();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  h.record({ label: "slow", undo: () => gate, redo: async () => {} });
  h.record(entry("B", []));
  const first = h.undo();
  assert.equal(h.getState().busy, true);
  assert.equal(await h.undo(), false);
  release();
  assert.equal(await first, true);
  assert.equal(h.getState().undoLabel, "slow");
});

test(`the history keeps the last ${UNDO_LIMIT} steps`, () => {
  const h = new UndoHistory();
  for (let i = 0; i < UNDO_LIMIT + 5; i++) h.record(entry(`step ${i}`, []));
  assert.equal(h.getState().undoLabel, `step ${UNDO_LIMIT + 4}`);
});

test("subscribers hear every change, and the state object is stable between changes", async () => {
  const h = new UndoHistory();
  let calls = 0;
  h.subscribe(() => calls++);
  const before = h.getState();
  assert.equal(h.getState(), before);
  h.record(entry("A", []));
  assert.notEqual(h.getState(), before);
  await h.undo(); // busy on, busy off
  assert.equal(calls, 3);
});
