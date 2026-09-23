// Unit tests for per-case choices and the run approval (bj-finance #519,
// ruled 2026-09-22).   npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { approvalBlocker, approvalSnapshot, paysApprover, validateChoice } from "./choices.ts";
import type { Finding } from "./verify.ts";
import { payWindowEnding, type PayWindow } from "./window.ts";

const WINDOW: PayWindow = (() => {
  const r = payWindowEnding("2026-09-20");
  if (!r.ok) throw new Error(r.error);
  return r.window;
})();
/** A day after WINDOW has ended. */
const AFTER = "2026-09-22";

const MGR = { id: "m", role: "manager", active: true };
const STAFF = { id: "s", role: "employee", active: true };

test("skip names nobody; naming somebody on a skip is refused", () => {
  assert.equal(validateChoice("1.9", "skip", null, null), null);
  assert.match(validateChoice("1.9", "skip", "m", MGR)!, /pays nobody/);
  assert.equal(validateChoice("1.5", "as_punched", null, null), null);
});

test("a paying choice must name an active person", () => {
  assert.match(validateChoice("3.5", "staff", null, null)!, /Pick the person/);
  assert.match(validateChoice("3.5", "staff", "x", null)!, /not an active team member/);
  assert.match(validateChoice("3.7", "staff", "s", { ...STAFF, active: false })!, /not an active/);
  assert.equal(validateChoice("3.7", "staff", "s", STAFF), null);
  assert.equal(validateChoice("1.9", "scheduled_closer", "s", STAFF), null);
});

test("pay unpunched manager must name a manager", () => {
  assert.match(validateChoice("1.9", "unpunched_manager", "s", STAFF)!, /Pick a manager/);
  assert.equal(validateChoice("1.9", "unpunched_manager", "m", MGR), null);
});

test("unknown checks and choices are refused", () => {
  assert.match(validateChoice("1.1", "void", null, null)!, /decided by rule/);
  assert.match(validateChoice("", "void", null, null)!, /That check/);
  assert.match(validateChoice("1.9", "early_close", null, null)!, /not one of the options/);
  assert.match(validateChoice("1.9", "", null, null)!, /That choice/);
});

function f(over: Partial<Finding>): Finding {
  return {
    check: "3.5",
    title: "",
    rule: "",
    key: "3.5:deal:1",
    status: "needs_ruling",
    severity: "warn",
    summary: "",
    evidence: {},
    ...over,
  };
}

test("the snapshot records every case's effective choice, defaults included", () => {
  const snap = approvalSnapshot([
    f({ effective: { choice: "staff", payee: { id: "s", name: "Sophia" }, source: "default" } }),
    f({ check: "1.5", key: "1.5:punch:9", ruling: { check_id: "1.5", finding_key: "1.5:punch:9", choice: "as_punched" } }),
    f({ check: "1.1", key: "1.1:punch:3", status: "needs_fix" }),
  ]);
  assert.deepEqual(snap, [
    { key: "3.5:deal:1", check: "3.5", choice: "staff", payee_id: "s", payee_name: "Sophia", source: "default" },
    { key: "1.5:punch:9", check: "1.5", choice: "as_punched", payee_id: null, payee_name: null, source: "recorded" },
  ]);
});

test("an unanswered no-default case snapshots as empty rather than guessed", () => {
  const [entry] = approvalSnapshot([f({ check: "1.4", key: "1.4:punch:2" })]);
  assert.equal(entry.choice, "");
});

test("approval is blocked by a missing table, a fix, or an unanswered case, and nothing else", () => {
  const counts = { total: 0, autoResolved: 0, needsRuling: 0, ruled: 0, defaulted: 0, needsFix: 0 };
  const base = { ready: true, counts, window: WINDOW, approval: null };
  assert.match(approvalBlocker(base, false, AFTER)!, /migration 27/);
  assert.match(approvalBlocker({ ...base, ready: false, counts: { ...counts, needsFix: 2 } }, true, AFTER)!, /2 finding/);
  assert.match(approvalBlocker({ ...base, ready: false }, true, AFTER)!, /still need a choice/);
  assert.equal(approvalBlocker(base, true, AFTER), null);
});

test("approval is only available after the pay period has ended", () => {
  const counts = { total: 0, autoResolved: 0, needsRuling: 0, ruled: 0, defaulted: 0, needsFix: 0 };
  const base = { ready: true, counts, window: WINDOW, approval: null };
  // On the period's own Sunday it has not ended.
  assert.equal(
    approvalBlocker(base, true, "2026-09-20"),
    "The pay period ends 2026-09-20. It can be approved from 2026-09-21.",
  );
  assert.match(approvalBlocker(base, true, "2026-09-14")!, /can be approved from 2026-09-21/);
  assert.equal(approvalBlocker(base, true, "2026-09-21"), null);
});

test("approval is final: an approved run, or one sharing days with an approved run, cannot be approved", () => {
  const counts = { total: 0, autoResolved: 0, needsRuling: 0, ruled: 0, defaulted: 0, needsFix: 0 };
  const base = { ready: true, counts, window: WINDOW, approval: null };
  const given = { approved_by: "m", approved_at: "2026-09-21T16:00:00Z" };
  assert.equal(approvalBlocker({ ...base, approval: given }, true, AFTER), "This pay run is already approved. Approval is final.");
  assert.match(
    approvalBlocker(base, true, AFTER, [{ window_end: "2026-09-13" }])!,
    /run ending 2026-09-13 is already approved and shares days/,
  );
  assert.equal(approvalBlocker(base, true, AFTER, [{ window_end: undefined }]), null);
});

test("approving would pay you: crewless and Olo cases only", () => {
  const mine = f({ effective: { choice: "staff", payee: { id: "me", name: "Me" }, source: "default" } });
  const olo = f({ check: "3.7", key: "3.7:olo:x", effective: { choice: "staff", payee: { id: "me", name: "Me" }, source: "recorded" } });
  const night = f({ check: "1.9", key: "1.9:d", effective: { choice: "unpunched_manager", payee: { id: "me", name: "Me" }, source: "recorded" } });
  const theirs = f({ effective: { choice: "staff", payee: { id: "them", name: "Them" }, source: "default" } });
  assert.deepEqual(paysApprover([mine, olo, night, theirs], "me"), [mine, olo]);
});
