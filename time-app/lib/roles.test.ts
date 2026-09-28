// The owner role (migration 31): an owner passes every manager gate, and a
// manager cannot give, take away or touch the owner role.
//
//   npm test        (node --test; Node runs TypeScript directly)
//
// The database half (is_manager() true for owners, the owner guard on
// profiles) is supabase/migration_31_verify.sql.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assignableRoles,
  canAssignRole,
  canEditProfile,
  isManager,
  isOwner,
  profilePatchRefusal,
  OWNER_ONLY_EDIT,
} from "./roles.ts";
import { financeAccess } from "./financeAccess.ts";
import { TYPES_BY_ROLE } from "./notifPrefs.ts";

const owner = { role: "owner" };
const manager = { role: "manager" };
const employee = { role: "employee" };

// ---- owner passes every manager gate ----------------------------------------

test("isManager: owners and managers pass, employees and nobody do not", () => {
  assert.equal(isManager(owner), true);
  assert.equal(isManager(manager), true);
  assert.equal(isManager(employee), false);
  assert.equal(isManager(null), false);
  assert.equal(isOwner(owner), true);
  assert.equal(isOwner(manager), false);
});

test("financeAccess: an owner off the roster is allowed", () => {
  assert.equal(financeAccess({ role: "owner", active: false }), "allowed");
  assert.equal(financeAccess({ role: "owner", active: true }), "allowed");
});

test("an owner gets the manager notification choices on the Account page", () => {
  assert.deepEqual(TYPES_BY_ROLE.owner, TYPES_BY_ROLE.manager);
});

const ROOTS = ["app", "components", "lib"].map((d) => join(import.meta.dirname, "..", d));

function sources(): { file: string; src: string }[] {
  return ROOTS.flatMap((root) =>
    readdirSync(root, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"))
      .map((f) => ({ file: join(root, f), src: readFileSync(join(root, f), "utf8") })),
  );
}

// A gate written as role === "manager" would shut the owners out. Every gate
// goes through lib/roles.ts instead; the invite route's parsing of a requested
// role (body.role) is the one comparison with the word left, and it is not a
// gate.
test("no gate compares a role to \"manager\" directly", () => {
  const offenders: string[] = [];
  for (const { file, src } of sources()) {
    if (file.endsWith(join("lib", "roles.ts"))) continue;
    for (const m of src.matchAll(/(\w+)\??\.role\s*[!=]==\s*"manager"|"role",\s*"manager"|\brole\s*[!=]==\s*"manager"/g)) {
      if (m[1] === "body") continue;
      offenders.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("every \"Managers only\" refusal is decided by isManager or financeAccess", () => {
  for (const { file, src } of sources()) {
    if (!src.includes('"Managers only"')) continue;
    assert.match(src, /isManager\(|financeAccess\(/, `${file} refuses "Managers only" without the shared check`);
  }
});

// ---- the owner role is the owners' to give ----------------------------------

test("assignableRoles: owners may give any role, managers never the owner role", () => {
  assert.deepEqual(assignableRoles(owner), ["employee", "manager", "owner"]);
  assert.deepEqual(assignableRoles(manager), ["employee", "manager"]);
  assert.deepEqual(assignableRoles(employee), []);
  assert.equal(canAssignRole(manager, "owner"), false);
  assert.equal(canAssignRole(owner, "owner"), true);
});

test("canEditProfile: a manager cannot edit an owner's row; an owner can edit anyone", () => {
  assert.equal(canEditProfile(manager, owner), false);
  assert.equal(canEditProfile(manager, manager), true);
  assert.equal(canEditProfile(manager, employee), true);
  assert.equal(canEditProfile(owner, owner), true);
  assert.equal(canEditProfile(owner, employee), true);
  assert.equal(canEditProfile(employee, employee), false);
});

test("profilePatchRefusal: a manager cannot promote anyone to owner", () => {
  assert.equal(profilePatchRefusal(manager, employee, { role: "owner" }), OWNER_ONLY_EDIT);
  assert.equal(profilePatchRefusal(manager, manager, { role: "owner" }), OWNER_ONLY_EDIT);
});

test("profilePatchRefusal: a manager cannot demote or edit an owner", () => {
  assert.equal(profilePatchRefusal(manager, owner, { role: "manager" }), OWNER_ONLY_EDIT);
  assert.equal(profilePatchRefusal(manager, owner, { phone: "555-0100" }), OWNER_ONLY_EDIT);
  assert.equal(profilePatchRefusal(manager, owner, { active: true }), OWNER_ONLY_EDIT);
});

test("profilePatchRefusal: ordinary manager edits still go through", () => {
  assert.equal(profilePatchRefusal(manager, employee, { role: "manager" }), null);
  assert.equal(profilePatchRefusal(manager, manager, { role: "employee" }), null);
  assert.equal(profilePatchRefusal(manager, employee, { hourly_rate: 16 }), null);
  // Saving a row with its role unchanged is not a role change.
  assert.equal(profilePatchRefusal(manager, employee, { role: "employee", phone: "x" }), null);
});

test("profilePatchRefusal: an owner can grant and remove the owner role", () => {
  assert.equal(profilePatchRefusal(owner, manager, { role: "owner" }), null);
  assert.equal(profilePatchRefusal(owner, owner, { role: "manager" }), null);
});

test("profilePatchRefusal: an unknown role is refused for everyone", () => {
  assert.equal(profilePatchRefusal(owner, employee, { role: "admin" }), "Unknown role.");
});
