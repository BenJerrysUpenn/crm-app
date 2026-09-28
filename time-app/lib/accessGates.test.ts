// Access never depends on profiles.active (audit H2).
//
// `active` means "on the staff roster": the schedule, the staff pickers and
// payroll. It does not mean "may sign in". The owners are managers kept off
// the roster (active = false) and still sign in every day, so a gate that
// checked `active` would lock them out of both apps. Access ends one way:
// offboarding bans the auth user and revokes its sessions (crm-app PR #19),
// or a ban in Supabase Auth. Supabase then refuses the login and getUser(),
// which every gate below calls first.
//
// This reads the gates' source so a well-meant "add `and active`" fix, the
// one the audit first suggested, fails here rather than on the owners' phones.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TIME = join(import.meta.dirname, "..");
const CRM = join(TIME, "..");

const GATES = [
  join(TIME, "middleware.ts"),
  join(TIME, "lib", "supabase", "middleware.ts"),
  join(TIME, "lib", "auth.ts"),
  join(TIME, "lib", "financeAccess.ts"),
  join(CRM, "middleware.ts"),
  join(CRM, "lib", "supabase", "middleware.ts"),
];

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no sign-in or role gate reads profiles.active", () => {
  for (const path of GATES) {
    const src = code(path);
    assert.doesNotMatch(src, /\.active\b/, `${path} reads .active`);
    assert.doesNotMatch(src, /["']active["']/, `${path} filters on "active"`);
  }
});
