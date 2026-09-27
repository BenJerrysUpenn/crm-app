// Unit tests for the QBO roster map (payroll spec §2.5).
//
//   npm test        (node --test — Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  duplicateMappings,
  parseQboEmployeeId,
  unmappedProfiles,
  type RosterProfile,
} from "./qboEmployee.ts";

function ok(value: unknown) {
  const parsed = parseQboEmployeeId(value);
  assert.equal(parsed.ok, true, `expected ${JSON.stringify(value)} to parse`);
  return parsed.ok ? parsed.value : null;
}

function err(value: unknown) {
  const parsed = parseQboEmployeeId(value);
  assert.equal(parsed.ok, false, `expected ${JSON.stringify(value)} to be refused`);
  return parsed.ok ? "" : parsed.error;
}

test("2.5: an id is stored as typed, with surrounding whitespace removed", () => {
  assert.equal(ok("4"), "4");
  assert.equal(ok("  1042  "), "1042");
  assert.equal(ok("EMP-77_b"), "EMP-77_b");
});

test("2.5: a number is accepted — QBO returns ids as numbers in some payloads", () => {
  assert.equal(ok(1042), "1042");
});

test("2.5: blank in every dialect means 'not mapped', never an empty string", () => {
  // The unique index is partial on `qbo_employee_id is not null`. An empty
  // string would sit in it pretending to be a mapping, and the second person
  // cleared the same way would collide with the first.
  assert.equal(ok(undefined), null);
  assert.equal(ok(null), null);
  assert.equal(ok(""), null);
  assert.equal(ok("   "), null);
});

test("2.5: an email address is refused — the commonest wrong paste", () => {
  assert.match(err("sophia@benjerryphilly.com"), /not an email address/);
});

test("2.5: whitespace inside is refused rather than squeezed out", () => {
  // Two things were pasted. Guessing which one is the id is worse than asking.
  assert.match(err("1042 Kieran"), /no spaces/);
});

test("2.5: a name is refused — the join is never by name", () => {
  assert.match(err("Kieran Flint"), /no spaces/);
  assert.match(err("piper!"), /digits and letters/);
});

test("2.5: something far too long is refused", () => {
  assert.match(err("9".repeat(65)), /too long/);
});

const ROSTER: RosterProfile[] = [
  { id: "a", full_name: "Wright, Sylvia", active: true, qbo_employee_id: "11" },
  { id: "b", full_name: "Freeman, Carli", active: true, qbo_employee_id: null },
  { id: "c", full_name: "Allen, James", active: true, qbo_employee_id: "  " },
  { id: "d", full_name: "Barrett, Joey", active: false, qbo_employee_id: null },
  { id: "e", full_name: "Malmgren, Sophia", active: true, qbo_employee_id: "12" },
];

test("2.5: the unmapped list is active people only, by name", () => {
  // A former employee with no id is not a problem to fix; listing them would
  // bury the person who is about to be paid and cannot be.
  assert.deepEqual(
    unmappedProfiles(ROSTER).map((p) => p.full_name),
    ["Allen, James", "Freeman, Carli"],
  );
});

test("2.5: two people on one QBO employee id are reported together", () => {
  const clash: RosterProfile[] = [
    ...ROSTER,
    { id: "f", full_name: "Flint, Kieran", active: true, qbo_employee_id: "11" },
  ];
  const dupes = duplicateMappings(clash);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].qbo_employee_id, "11");
  assert.deepEqual(dupes[0].profiles.map((p) => p.id), ["a", "f"]);
});

test("2.5: a roster with no clash reports none", () => {
  assert.deepEqual(duplicateMappings(ROSTER), []);
});
