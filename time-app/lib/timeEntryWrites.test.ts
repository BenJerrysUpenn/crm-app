// Who may write a punch (audit H1, migration 30).
//
// Migration 30 takes insert and update on time_entries away from employees'
// own sessions: through RLS only a manager may write one. Every write an
// employee can set off (clocking in or out, snoozing the clock-out nudge) must
// therefore go through the service-role client, after the route's own checks.
// A route that writes a punch through the signed-in session instead would
// work for a manager and fail for everyone else, which on the clock is a
// person at the counter who cannot clock in. These tests read the route
// source, as financeAccess.test.ts does, so a new writer cannot slip past.
//
// The database half (the policies, the claim guard, the Pi's service-role
// writes) is supabase/migration_30_verify.sql.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dirname, "..", "app");

// Routes allowed to write time_entries through the signed-in session: each of
// their handlers refuses non-managers before it does anything else.
const MANAGER_ONLY = new Set([
  join("api", "time-entries", "route.ts"),
  join("api", "time-entries", "[id]", "route.ts"),
]);

type Write = { file: string; client: string; op: string };

function routeFiles(): string[] {
  return readdirSync(APP, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith("route.ts"));
}

// `<client>\n  .from("time_entries")\n  .insert(` and friends, across lines.
const WRITE = /(\w+)\s*\.from\(\s*"time_entries"\s*\)\s*\.(insert|update|upsert|delete)\(/g;

function writesIn(file: string): Write[] {
  const src = readFileSync(join(APP, file), "utf8");
  return [...src.matchAll(WRITE)].map((m) => ({ file, client: m[1], op: m[2] }));
}

test("the clock and the clock-out nudge write punches (the routes an employee reaches)", () => {
  const writers = new Set(routeFiles().filter((f) => writesIn(f).length > 0));
  for (const f of [
    join("api", "clock", "route.ts"),
    join("api", "time-entries", "[id]", "clockout-reminder", "route.ts"),
  ]) {
    assert.ok(writers.has(f), `${f} no longer writes time_entries; update this test`);
  }
});

test("every time_entries write outside the manager-only routes uses the service role", () => {
  const offenders: string[] = [];
  for (const file of routeFiles()) {
    if (MANAGER_ONLY.has(file)) continue;
    for (const w of writesIn(file)) {
      if (w.client !== "admin" && w.client !== "supabase") {
        offenders.push(`${file}: ${w.op} through an unrecognised client "${w.client}"`);
        continue;
      }
      // The cron route's `supabase` IS the service role (createAdminClient).
      const src = readFileSync(join(APP, file), "utf8");
      const sessionIsAdmin = /const supabase = createAdminClient\(\)/.test(src);
      if (w.client === "supabase" && !sessionIsAdmin) {
        offenders.push(`${file}: ${w.op} through the signed-in session`);
      }
    }
  }
  assert.deepEqual(offenders, [], "employees cannot write time_entries through their own session");
});

test("the manager-only punch routes refuse non-managers before anything else", () => {
  for (const file of MANAGER_ONLY) {
    const src = readFileSync(join(APP, file), "utf8");
    const handlers = src.split(/export async function (?=GET|POST|PUT|PATCH|DELETE)/).slice(1);
    assert.ok(handlers.length > 0, `${file}: no handlers found`);
    for (const body of handlers) {
      const name = body.slice(0, body.indexOf("("));
      const head = body.split("\n").slice(0, 8).join("\n");
      assert.match(
        head,
        /if \(!profile \|\| profile\.role !== "manager"\)\s*\n\s*return NextResponse\.json\(\{ error: "Managers only" \}, \{ status: 403 \}\)/,
        `${file} ${name}: must refuse non-managers first`,
      );
    }
  }
});

test("/api/clock runs the reminder gate and the geofence before it writes, and never sends a clock-in time", () => {
  const src = readFileSync(join(APP, "api", "clock", "route.ts"), "utf8");
  const insertAt = src.search(/\.from\("time_entries"\)\s*\.insert\(/);
  assert.ok(insertAt > 0, "clock-in insert not found");
  assert.ok(src.indexOf("getPendingReminders(") > 0, "reminder gate missing");
  assert.ok(src.indexOf("getPendingReminders(") < insertAt, "reminder gate must run before the insert");
  const fence = src.indexOf("distance > loc.radius_meters");
  assert.ok(fence > 0 && fence < insertAt, "geofence must run before the insert");

  const insertBody = src.slice(insertAt, src.indexOf("})", insertAt));
  assert.doesNotMatch(insertBody, /clock_in_at/, "clock_in_at must come from the database default");
  assert.match(insertBody, /employee_id: user\.id/, "the punch must be for the signed-in person");
});

test("/api/clock closes only the caller's own open entry", () => {
  const src = readFileSync(join(APP, "api", "clock", "route.ts"), "utf8");
  const updateAt = src.search(/\.from\("time_entries"\)\s*\.update\(/);
  assert.ok(updateAt > 0, "clock-out update not found");
  const tail = src.slice(updateAt, src.indexOf(".select()", updateAt));
  assert.match(tail, /\.eq\("employee_id", user\.id\)/);
  assert.match(tail, /\.eq\("status", "open"\)/);
});
