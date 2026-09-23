// Run with: node --test lib/payroll/payType.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAY_TYPE_LABELS, PAY_TYPES, parsePayType } from "./payType.ts";

test("both pay types are accepted, whatever the case and padding", () => {
  assert.deepEqual(parsePayType("hourly"), { ok: true, value: "hourly" });
  assert.deepEqual(parsePayType(" Salaried "), { ok: true, value: "salaried" });
});

test("blank in every dialect is 'not set', never a guessed hourly", () => {
  for (const blank of [null, undefined, "", "   "]) {
    assert.deepEqual(parsePayType(blank), { ok: true, value: null });
  }
});

test("anything else is refused with the allowed words", () => {
  const bad = parsePayType("contractor");
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /hourly, salaried/);
  assert.equal(parsePayType(1).ok, false);
});

test("every pay type has a label, and so does 'not set'", () => {
  for (const t of PAY_TYPES) assert.ok(PAY_TYPE_LABELS[t]);
  assert.equal(PAY_TYPE_LABELS[""], "not set");
});
