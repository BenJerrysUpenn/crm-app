// Unit tests for the display-name rules (public.profiles.full_name),
// bj-finance #468: a real name, no name, or an email sitting where the name
// should be (pre-migration_21 rows). An email-like value counts as no name.
//
//   npm test        (node --test lib/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  displayName,
  displayNameOrId,
  firstName,
  usableName,
  validateFullName,
} from "./profileName.ts";

test("a real name is shown trimmed", () => {
  assert.equal(usableName("  Sam Lee  "), "Sam Lee");
  assert.equal(displayName(" Sam Lee "), "Sam Lee");
});

test("an email sitting in the name is never shown as a name", () => {
  assert.equal(usableName("staff2@example.com"), null);
  assert.equal(displayName("staff2@example.com"), "No name set");
});

test("a missing or blank name shows the neutral label", () => {
  for (const none of [null, undefined, "", "   "]) {
    assert.equal(usableName(none), null, `usableName(${JSON.stringify(none)})`);
    assert.equal(displayName(none), "No name set", `displayName(${JSON.stringify(none)})`);
  }
});

test("a caller's fallback replaces the neutral label, but never a real name", () => {
  assert.equal(displayName(null, "An employee"), "An employee");
  assert.equal(displayName("staff2@example.com", "An employee"), "An employee");
  assert.equal(displayName("Sam Lee", "An employee"), "Sam Lee");
});

test("unnamed people in a list stay distinguishable by the first 8 chars of their id", () => {
  const a = "11111111-aaaa-4bbb-8ccc-000000000001";
  const b = "22222222-aaaa-4bbb-8ccc-000000000002";
  assert.equal(displayNameOrId(null, a), "No name set (11111111)");
  assert.equal(displayNameOrId("staff3@example.com", b), "No name set (22222222)");
  assert.equal(displayNameOrId(" Sam Lee ", a), "Sam Lee");
});

test("a greeting uses the first word of a real name, and nothing for an email or blank", () => {
  assert.equal(firstName("  Sam   Lee "), "Sam");
  assert.equal(firstName("Sam\tLee"), "Sam", "any whitespace ends the first name");
  assert.equal(firstName("Cher"), "Cher");
  assert.equal(firstName("staff2@example.com"), null);
  assert.equal(firstName(null), null);
  assert.equal(firstName("  "), null);
});

test("a typed name is accepted trimmed", () => {
  assert.deepEqual(validateFullName("  Sam Lee "), { ok: true, name: "Sam Lee" });
});

test("a typed name is required", () => {
  for (const bad of [undefined, null, "", "   ", 42]) {
    assert.deepEqual(
      validateFullName(bad),
      { ok: false, error: "Full name is required." },
      `validateFullName(${JSON.stringify(bad)})`,
    );
  }
});

test("an email typed as a name is refused", () => {
  assert.deepEqual(validateFullName("sam@example.com"), {
    ok: false,
    error: "Enter the person's name, not their email address.",
  });
});

test("a typed name may be 100 characters but not 101", () => {
  assert.deepEqual(validateFullName("x".repeat(100)), { ok: true, name: "x".repeat(100) });
  assert.deepEqual(validateFullName(` ${"x".repeat(100)} `), { ok: true, name: "x".repeat(100) });
  assert.deepEqual(validateFullName("x".repeat(101)), {
    ok: false,
    error: "Full name must be 100 characters or fewer.",
  });
});
