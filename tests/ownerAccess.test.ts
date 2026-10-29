// The owner role in the CRM (time-app migration 42).
//
//   * The personal-finance pages (/money, /dial, /safe) are for owners only.
//     An owner gets the feed. Anyone else signed in gets a 404 (the page does
//     not admit it exists, bj-finance #667 ruling), never /no-access, and the
//     feed is never read for them. Checked on the page, before the feed.
//   * Everywhere else an owner passes the manager gate; an employee is sent
//     to /no-access on every path, these included, as on any CRM path.
//   * Signed out goes to /login.
//   * Nothing reads the feed except through lib/pf/access.ts.
//   * Nothing looks at profiles.active (audit H2).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import React from "react";

import { isManagerRole, isOwnerRole, isPfPath, isPfRoute } from "@/lib/roles";

// ---- a stand-in Supabase: one signed-in person with a role -----------------
const who = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  role: null as string | null,
  active: true,
}));

function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: who.user } }) },
    from(table: string) {
      if (table !== "profiles") throw new Error(`unexpected table ${table}`);
      // Like PostgREST, answer only for the row the query asks for: a gate
      // that looked up anyone but the signed-in person finds no profile.
      let row = who.user ? { role: who.role, active: who.active } : null;
      const b = {
        select: () => b,
        eq: (column: string, value: unknown) => {
          if (column !== "id" || value !== who.user?.id) row = null;
          return b;
        },
        single: async () =>
          row
            ? { data: row, error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } },
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return b;
    },
  };
}

vi.mock("@supabase/ssr", () => ({ createServerClient: () => fakeClient() }));
// The pages' Supabase client (lib/supabase/server.ts) runs for real; only the
// request's cookie jar, which Next supplies inside a request, is stood in for.
vi.mock("next/headers", () => ({ cookies: () => ({ getAll: () => [], set: () => {} }) }));
// Next implements both as throws; the tests read which one fired.
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const { updateSession } = await import("@/lib/supabase/middleware");
const { middleware } = await import("@/middleware");
const { loadPfForOwner } = await import("@/lib/pf/access");

function signIn(role: string | null, active = true) {
  who.user = { id: "00000000-0000-0000-0000-000000000001", email: "someone@example.test" };
  who.role = role;
  who.active = active;
}

beforeEach(() => {
  who.user = null;
  who.role = null;
  who.active = true;
});

async function gate(path: string) {
  const res = await updateSession(new NextRequest(`https://crm.withers-ventures.com${path}`));
  const location = res.headers.get("location");
  return location ? new URL(location).pathname : "through";
}

describe("the role rules", () => {
  it("an owner is a manager; a manager is not an owner", () => {
    expect(isManagerRole("owner")).toBe(true);
    expect(isManagerRole("manager")).toBe(true);
    expect(isManagerRole("employee")).toBe(false);
    expect(isOwnerRole("owner")).toBe(true);
    expect(isOwnerRole("manager")).toBe(false);
  });

  it.each(["/money", "/dial", "/safe", "/safe/anything"])("%s is a personal-finance path", (p) => {
    expect(isPfPath(p)).toBe(true);
  });

  it.each(["/", "/moneyx", "/call-desk", "/safely"])("%s is not", (p) => {
    expect(isPfPath(p)).toBe(false);
  });

  // isPfRoute is the whole pf set — the pages plus the /api/pf API — named once
  // here so the middleware does not repeat the prefix (CODING_STANDARDS.md:9).
  it.each(["/money", "/safe/anything", "/api/pf", "/api/pf/overrides"])(
    "%s is a personal-finance route",
    (p) => {
      expect(isPfRoute(p)).toBe(true);
    },
  );

  it.each(["/", "/call-desk", "/api/pfx", "/api/deals"])(
    "%s is not a personal-finance route",
    (p) => {
      expect(isPfRoute(p)).toBe(false);
    },
  );
});

describe("the middleware gate", () => {
  it.each(["/money", "/dial", "/safe"])("lets an owner into %s", async (p) => {
    signIn("owner", false);
    expect(await gate(p)).toBe("through");
  });

  // Never /no-access for a manager here: that would admit the page exists.
  // The page answers them 404 (the page-level tests below).
  it.each(["/money", "/dial", "/safe"])("passes a manager on to %s, for the page to refuse", async (p) => {
    signIn("manager");
    expect(await gate(p)).toBe("through");
  });

  it.each(["/money", "/dial", "/safe"])("sends an employee from %s to /no-access, as from any path", async (p) => {
    signIn("employee");
    expect(await gate(p)).toBe("/no-access");
  });

  it.each(["/", "/call-desk", "/deals/25401", "/email-campaigns"])(
    "lets an owner off the roster through the manager gate at %s",
    async (p) => {
      signIn("owner", false);
      expect(await gate(p)).toBe("through");
    },
  );

  it("still lets a manager onto the board, and an inactive manager too", async () => {
    signIn("manager");
    expect(await gate("/")).toBe("through");
    signIn("manager", false);
    expect(await gate("/")).toBe("through");
  });

  it("still keeps employees out of the CRM", async () => {
    signIn("employee");
    expect(await gate("/")).toBe("/no-access");
  });

  it("sends nobody-signed-in to /login", async () => {
    expect(await gate("/money")).toBe("/login");
  });
});

// The personal-finance host runs the whole middleware (host routing, then
// the gate above). An employee refused there must land on /no-access and be
// able to sign out, not bounce to /safe and back again.
describe("the personal-finance host", () => {
  const PF = "personal.withers-ventures.com";

  async function visit(path: string, method = "GET") {
    const res = await middleware(new NextRequest(`https://${PF}${path}`, { method, headers: { host: PF } }));
    const location = res.headers.get("location");
    return location ? new URL(location).pathname : "through";
  }

  it.each(["/money", "/dial", "/safe"])("lets an owner into %s", async (p) => {
    signIn("owner", false);
    expect(await visit(p)).toBe("through");
  });

  it.each(["/money", "/dial", "/safe"])("passes a manager on to %s, for the page to refuse", async (p) => {
    signIn("manager");
    expect(await visit(p)).toBe("through");
  });

  it("sends an employee to /no-access and shows them that page", async () => {
    signIn("employee");
    expect(await visit("/safe")).toBe("/no-access");
    expect(await visit("/no-access")).toBe("through");
  });

  it("lets a refused employee sign out", async () => {
    signIn("employee");
    expect(await visit("/api/logout", "POST")).toBe("through");
  });

  it("sends nobody-signed-in to /login", async () => {
    expect(await visit("/safe")).toBe("/login");
  });

  it("still keeps the CRM board off this host, even for an owner", async () => {
    signIn("owner", false);
    expect(await visit("/call-desk")).toBe("/safe");
  });
});

describe("the page-level check (loadPfForOwner)", () => {
  // The pages themselves, run as Next runs a server component. The feed is
  // fetched from GitHub (lib/pf/data.ts), the system boundary, stubbed here
  // so the test can see whether a refused visitor's request ever reached it.
  const pages = {
    money: () => import("@/app/money/page"),
    dial: () => import("@/app/dial/page"),
    safe: () => import("@/app/safe/page"),
  };

  function stubFeed() {
    const asked: string[] = [];
    // Vitest compiles the pages' JSX with the classic runtime, which wants
    // React in scope; Next's own compiler does not.
    vi.stubGlobal("React", React);
    vi.stubEnv("PF_DATA_PATH", "");
    vi.stubEnv("PF_GITHUB_TOKEN", "test-token-not-real");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response("not found", { status: 404 });
    });
    return asked;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("gives an owner the feed and their email", async () => {
    const asked = stubFeed();
    signIn("owner", false);
    const { email, feed } = await loadPfForOwner();
    expect(email).toBe("someone@example.test");
    expect(feed).toEqual({ ok: false, reason: "missing" });
    expect(asked).toHaveLength(1);
  });

  it.each(["manager", "employee", null])("is a 404 for role %s, and fetches nothing", async (role) => {
    const asked = stubFeed();
    signIn(role);
    await expect(loadPfForOwner()).rejects.toThrow("NOT_FOUND");
    expect(asked).toEqual([]);
  });

  it("sends nobody-signed-in to /login, and fetches nothing", async () => {
    const asked = stubFeed();
    await expect(loadPfForOwner()).rejects.toThrow("REDIRECT /login");
    expect(asked).toEqual([]);
  });

  it.each(Object.keys(pages))("/%s is a 404 for a manager, before the feed is fetched", async (p) => {
    const asked = stubFeed();
    signIn("manager");
    const { default: Page } = await pages[p as keyof typeof pages]();

    await expect(Page()).rejects.toThrow("NOT_FOUND");
    expect(asked).toEqual([]);
  });

  it.each(Object.keys(pages))("/%s reads the feed for an owner", async (p) => {
    const asked = stubFeed();
    signIn("owner", false);
    const { default: Page } = await pages[p as keyof typeof pages]();

    await expect(Page()).resolves.toBeTruthy();
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0]).hostname).toBe("api.github.com");
  });

  it("nothing else reads the feed", () => {
    // Only lib/pf/access.ts imports the feed loader (lib/pf/data.ts); every
    // page and route goes through loadPfForOwner(). Declared exception to
    // CODING_STANDARDS.md:20 (a test may not infer behaviour from source
    // text): this is an import rule in test form. "Nothing reaches the
    // personal-finance feed around the owner check" has no behavioural form,
    // and the CRM ships no ESLint config where a no-restricted-imports rule
    // for @/lib/pf/data could live, so the restriction is enforced here until
    // one does.
    const root = join(__dirname, "..");
    const skip = new Set(["node_modules", ".next", ".git", ".claude", "time-app", "tests"]);
    const sourceFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        if (skip.has(name)) return [];
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return sourceFiles(full);
        return /\.(ts|tsx|js|mjs)$/.test(name) ? [full] : [];
      });
    const importers = sourceFiles(root)
      .filter((f) => /lib\/pf\/data["']|\.\/data["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f));
    expect(importers).toEqual([join("lib", "pf", "access.ts")]);
  });

  it("only the pf door reaches the service-role admin client", () => {
    // crm/011's corrections table admits only the service role, after the
    // owner check. lib/pf/access.ts builds the admin client behind that check
    // (loadMoneyForOwner reads the corrections, savePfOverride writes one) and
    // is the one pf module that imports it; no pf page or route reaches the
    // admin client itself, so none can touch the table around the gate. The
    // admin client is used all over the CRM, so this scopes to the pf surface
    // rather than the whole tree. Same import-rule-in-test-form, and the same
    // declared CODING_STANDARDS.md:20 exception, as "nothing else reads the
    // feed" above.
    const root = join(__dirname, "..");
    const pfDirs = [
      join("lib", "pf"),
      join("app", "money"),
      join("app", "dial"),
      join("app", "safe"),
      join("app", "api", "pf"),
    ];
    const sourceFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return sourceFiles(full);
        return /\.(ts|tsx)$/.test(name) ? [full] : [];
      });
    const importers = pfDirs
      .flatMap((d) => sourceFiles(join(root, d)))
      .filter((f) => /supabase\/admin["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      .sort();
    expect(importers).toEqual([join("lib", "pf", "access.ts")]);
  });
});
