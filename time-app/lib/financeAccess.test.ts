// Unit tests for who may see the finance pages and APIs (bj-finance #519):
// managers only. Pay is not something an employee sees a corner of.
//
//   npm test        (node --test — Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { financeAccess } from "./financeAccess.ts";

test("financeAccess: nobody signed in is sent to sign in", () => {
  assert.equal(financeAccess(null), "sign_in");
});

test("financeAccess: an active manager is allowed", () => {
  assert.equal(financeAccess({ role: "manager", active: true }), "allowed");
});

test("financeAccess: an employee is refused", () => {
  assert.equal(financeAccess({ role: "employee", active: true }), "refused");
});

test("financeAccess: a deactivated manager is refused", () => {
  assert.equal(financeAccess({ role: "manager", active: false }), "refused");
});

// Every handler under app/api/payroll must refuse before it reads anything. A
// new route that forgets the check would serve pay data to any signed-in
// person, so this reads the source rather than trusting a reviewer to notice.
test("every /api/payroll handler opens with the financeAccess check", () => {
  const root = join(import.meta.dirname, "..", "app", "api", "payroll");
  const routes = readdirSync(root, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith("route.ts"));
  assert.ok(routes.length >= 3, `expected the payroll routes, found ${routes.join(", ")}`);
  for (const file of routes) {
    const src = readFileSync(join(root, file), "utf8");
    const handlers = src.split(/export async function (?=GET|POST|PUT|PATCH|DELETE)/).slice(1);
    assert.ok(handlers.length > 0, `${file}: no handlers found`);
    for (const body of handlers) {
      const name = body.slice(0, body.indexOf("("));
      const head = body.split("\n").slice(0, 4).join("\n");
      assert.match(
        head,
        /if \(!(\w+) \|\| financeAccess\(\1\) !== "allowed"\)\s*\n\s*return NextResponse\.json\(\{ error: "Managers only" \}, \{ status: 403 \}\)/,
        `${file} ${name}: must refuse non-managers first`,
      );
    }
  }
});
