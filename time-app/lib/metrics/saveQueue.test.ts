// One save at a time per saved view (bj-finance #696): quick changes never
// land out of order.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { mergePatches, serialSaves } from "./saveQueue.ts";

type Patch = { from?: string; to?: string; position?: number };

/** A fake server: requests settle when the test says, and each write lands when it settles. */
function fakeServer() {
  const stored = new Map<string, Patch>();
  const inFlight: { key: string; patch: Patch; settle: (ok: boolean) => void }[] = [];
  const sent: Patch[] = [];
  const send = (key: string, patch: Patch) => {
    sent.push(patch);
    return new Promise<Patch>((resolve, reject) => {
      inFlight.push({
        key,
        patch,
        settle(ok) {
          if (!ok) return reject(new Error("Saving failed (500)."));
          const next = { ...stored.get(key), ...patch };
          stored.set(key, next);
          resolve(next);
        },
      });
    });
  };
  return { stored, inFlight, sent, send };
}

const tick = () => new Promise((r) => setImmediate(r));

test("serialised: the second save waits for the first, so the last choice is what is saved", async () => {
  const s = fakeServer();
  const save = serialSaves(s.send);
  const a = save("v1", { from: "2026-08-02", to: "2026-08-30" });
  const b = save("v1", { from: "2026-08-02", to: "2026-09-27" });
  await tick();
  assert.equal(s.inFlight.length, 1, "only one save on its way");
  s.inFlight[0].settle(true);
  await a;
  await tick();
  assert.equal(s.inFlight.length, 2, "the second goes once the first is back");
  s.inFlight[1].settle(true);
  await b;
  assert.deepEqual(s.stored.get("v1"), { from: "2026-08-02", to: "2026-09-27" });
});

test("changes that pile up behind a save go as one, later fields winning", async () => {
  const s = fakeServer();
  const save = serialSaves(s.send);
  const first = save("v1", { from: "2026-07-05", to: "2026-07-26" });
  const second = save("v1", { from: "2026-08-02", to: "2026-08-30" });
  const third = save("v1", { to: "2026-09-27" });
  await tick();
  s.inFlight[0].settle(true);
  await first;
  await tick();
  assert.equal(s.sent.length, 2);
  assert.deepEqual(s.sent[1], { from: "2026-08-02", to: "2026-09-27" });
  s.inFlight[1].settle(true);
  const [r2, r3] = await Promise.all([second, third]);
  // Both callers get the save that carried their change: the merged range as stored.
  assert.deepEqual(r2, { from: "2026-08-02", to: "2026-09-27" });
  assert.deepEqual(r3, { from: "2026-08-02", to: "2026-09-27" });
  assert.deepEqual(s.stored.get("v1"), { from: "2026-08-02", to: "2026-09-27" });
});

test("different views save independently", async () => {
  const s = fakeServer();
  const save = serialSaves(s.send);
  void save("v1", { position: 1 });
  void save("v2", { position: 0 });
  await tick();
  assert.equal(s.inFlight.length, 2);
  assert.deepEqual(s.inFlight.map((f) => f.key), ["v1", "v2"]);
});

test("a failed save still lets the next one go, and only its own callers hear of the failure", async () => {
  const s = fakeServer();
  const save = serialSaves(s.send);
  const a = save("v1", { to: "2026-08-30" });
  const b = save("v1", { to: "2026-09-27" });
  await tick();
  s.inFlight[0].settle(false);
  await assert.rejects(a, /Saving failed/);
  await tick();
  s.inFlight[1].settle(true);
  assert.deepEqual(await b, { to: "2026-09-27" });
  assert.equal(s.stored.get("v1")?.to, "2026-09-27");
});

test("a send that throws instead of rejecting is still reported, and the lane frees up", async () => {
  let calls = 0;
  const boom = serialSaves<Patch, string>(() => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return Promise.resolve("ok");
  });
  await assert.rejects(boom("v1", { to: "x" }), /boom/);
  assert.equal(await boom("v1", { to: "y" }), "ok");
});

test("mergePatches: later fields win, earlier ones kept", () => {
  assert.deepEqual(mergePatches<Patch>({ from: "a", to: "b" }, { to: "c" }), { from: "a", to: "c" });
});
