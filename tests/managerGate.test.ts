// The CRM's manager gate (lib/supabase/middleware.ts) never reads
// profiles.active (audit H2).
//
// `active` means "on the time app's staff roster", not "may sign in". The
// owners are managers kept off the roster (active = false) and use the CRM
// every day; a gate that checked `active` would lock them out. Access ends by
// banning the login (offboarding, crm-app PR #19), which Supabase enforces in
// getUser(). The time app's gates have the same test in
// time-app/lib/accessGates.test.ts.
//
// This drives the real middleware and updateSession; only the network to
// Supabase is stood in for, answering /auth/v1/user from the session cookie
// and /rest/v1/profiles from the rows below.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SUPABASE_URL = "http://fake-project.supabase.test";
const OWNER = "00000000-0000-0000-0000-00000000000a";
const EMPLOYEE = "00000000-0000-0000-0000-00000000000b";

const profiles = [
  { id: OWNER, role: "manager", active: false },
  { id: EMPLOYEE, role: "employee", active: true },
];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function fakeSupabase(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const userId = request.headers.get("authorization")?.replace(/^Bearer token-for-/, "");
  const user = profiles.find((p) => p.id === userId);
  if (url.pathname === "/auth/v1/user") {
    return user ? json(200, { id: user.id, aud: "authenticated", role: "authenticated" }) : json(401, { msg: "invalid JWT" });
  }
  if (url.pathname === "/rest/v1/profiles") {
    const id = url.searchParams.get("id")?.replace(/^eq\./, "");
    const rows = user ? profiles.filter((p) => p.id === id) : [];
    if (request.headers.get("accept")?.startsWith("application/vnd.pgrst.object+json")) {
      return rows.length === 1 ? json(200, rows[0]) : json(406, { code: "PGRST116", message: "no rows" });
    }
    return json(200, rows);
  }
  throw new Error(`unexpected request to ${url.pathname}`);
}

function sessionCookie(userId: string) {
  const session = {
    access_token: `token-for-${userId}`,
    refresh_token: `refresh-for-${userId}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, aud: "authenticated", role: "authenticated" },
  };
  return `sb-fake-project-auth-token=${encodeURIComponent(JSON.stringify(session))}`;
}

function visit(path: string, userId: string) {
  const host = "crm.withers-ventures.com";
  return new NextRequest(`https://${host}${path}`, { headers: { host, cookie: sessionCookie(userId) } });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fake-anon-key");
  vi.stubGlobal("fetch", fakeSupabase);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const { middleware } = await import("@/middleware");

describe("the CRM's manager gate", () => {
  it("lets an owner, a manager off the time app's roster, into the CRM", async () => {
    const response = await middleware(visit("/", OWNER));

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("sends an employee to /no-access", async () => {
    const response = await middleware(visit("/", EMPLOYEE));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/no-access");
  });
});
