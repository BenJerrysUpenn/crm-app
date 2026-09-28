// Access never depends on profiles.active (audit H2).
//
// `active` means "on the staff roster": the schedule, the staff pickers and
// payroll. It does not mean "may sign in". The owners are managers kept off
// the roster (active = false) and still sign in every day, so a gate that
// checked `active` would lock them out. Access ends one way: offboarding bans
// the auth user and revokes its sessions (crm-app PR #19), or a ban in
// Supabase Auth. Supabase then refuses the login and getUser(), which every
// gate calls first.
//
// These drive the time app's gates (the middleware, getProfile and the
// finance check) with an owner signed in, against a stand-in Supabase (see
// testing/fakeSupabase.ts), so a well-meant "and active" fix, the one the
// audit first suggested, fails here rather than on the owners' phones. The
// CRM's manager gate has the same test in tests/managerGate.test.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";
import { financeAccess } from "./financeAccess.ts";
import type { Profile } from "./types.ts";

const { middleware } = await loadAppModule<{ middleware: (r: NextRequest) => Promise<Response> }>("middleware.ts");
const { getProfile } = await loadAppModule<{ getProfile: () => Promise<Profile | null> }>("lib/auth.ts");

const OWNER = "00000000-0000-0000-0000-00000000000a";

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [{ id: OWNER, role: "manager", active: false, full_name: "Test Owner" }],
  });
});

function visit(path: string): NextRequest {
  const host = "finance.withers-ventures.com";
  return new NextRequest(`https://${host}${path}`, { headers: { host, cookie: db.cookieHeader() } });
}

test("an owner, a manager off the roster, gets past the sign-in gate", async () => {
  db.signIn(OWNER);

  const res = await middleware(visit("/payroll"));

  assert.equal(res.headers.get("location"), null);
  assert.equal(res.headers.get("x-middleware-next"), "1");
});

test("nobody signed in is sent to sign in", async () => {
  const res = await middleware(visit("/payroll"));

  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
});

test("an owner, a manager off the roster, is let into the finance pages", async () => {
  db.signIn(OWNER);

  assert.equal(financeAccess(await getProfile()), "allowed");
});
