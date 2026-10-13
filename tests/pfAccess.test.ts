// Who may see the personal-finance pages (/safe, /money, /dial).
//
// These pages carry the household's personal finances. The CRM's manager gate
// (middleware) is not enough: every `manager` profile in the shared Supabase
// project passes it, and store staff hold that role too. So the pages admit
// only the auth user IDs listed in the server-only env var
// PF_ALLOWED_USER_IDS (bj-finance #673). IDs live in Vercel, never in this
// public repo.
//
//   * allowed user          -> the page renders with the feed
//   * other signed-in user  -> 404, and the feed is never loaded
//   * signed out            -> the usual login redirect
//   * list unset or empty   -> nobody gets in (fail closed)
//
// The pages are driven for real; only Supabase, Next's navigation throws and
// the feed loader are stood in for.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALLOWED = "00000000-0000-0000-0000-0000000000a1";
const ALSO_ALLOWED = "00000000-0000-0000-0000-0000000000a2";
const STAFF_MANAGER = "00000000-0000-0000-0000-0000000000b1";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  loads: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
  }),
}));

// Next implements both as throws; the tests read which one fired.
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  usePathname: () => "/safe",
}));

vi.mock("@/lib/pf/data", () => ({
  loadPfData: async () => {
    state.loads += 1;
    return { ok: false, reason: "missing" };
  },
}));

const pages = {
  "/safe": (await import("@/app/safe/page")).default,
  "/money": (await import("@/app/money/page")).default,
  "/dial": (await import("@/app/dial/page")).default,
};
const { isPfViewerAllowed } = await import("@/lib/pf/guard");

function signIn(id: string | null) {
  state.user = id ? { id, email: `${id}@example.test` } : null;
}

beforeEach(() => {
  state.loads = 0;
  signIn(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(Object.entries(pages))("%s", (_path, Page) => {
  it("renders for a user on the allowlist", async () => {
    vi.stubEnv("PF_ALLOWED_USER_IDS", `${ALLOWED},${ALSO_ALLOWED}`);
    for (const id of [ALLOWED, ALSO_ALLOWED]) {
      signIn(id);
      await expect(Page()).resolves.toBeTruthy();
    }
    expect(state.loads).toBe(2);
  });

  it("is a 404 for any other signed-in user, and loads no data", async () => {
    vi.stubEnv("PF_ALLOWED_USER_IDS", `${ALLOWED},${ALSO_ALLOWED}`);
    signIn(STAFF_MANAGER);
    await expect(Page()).rejects.toThrow("NOT_FOUND");
    expect(state.loads).toBe(0);
  });

  it("sends a signed-out visitor to the login page", async () => {
    vi.stubEnv("PF_ALLOWED_USER_IDS", ALLOWED);
    signIn(null);
    await expect(Page()).rejects.toThrow("REDIRECT /login");
    expect(state.loads).toBe(0);
  });

  it("fails closed when the allowlist is unset or empty", async () => {
    signIn(ALLOWED);
    for (const value of [undefined, "", " ,  , "]) {
      vi.stubEnv("PF_ALLOWED_USER_IDS", value as string);
      await expect(Page()).rejects.toThrow("NOT_FOUND");
    }
    expect(state.loads).toBe(0);
  });
});

describe("isPfViewerAllowed", () => {
  it("accepts commas, spaces and newlines between IDs", () => {
    const raw = ` ${ALLOWED} ,\n${ALSO_ALLOWED}\n`;
    expect(isPfViewerAllowed(ALLOWED, raw)).toBe(true);
    expect(isPfViewerAllowed(ALSO_ALLOWED, raw)).toBe(true);
    expect(isPfViewerAllowed(STAFF_MANAGER, raw)).toBe(false);
  });

  it("matches whole IDs only", () => {
    expect(isPfViewerAllowed(ALLOWED.slice(0, 20), ALLOWED)).toBe(false);
    expect(isPfViewerAllowed("", ALLOWED)).toBe(false);
  });
});

// The guard is only a guard if nothing reaches the feed around it. Only the
// guard itself may import the loader; every page and route goes through it.
describe("the personal-finance feed", () => {
  const root = join(__dirname, "..");
  const skip = new Set(["node_modules", ".next", ".git", "time-app", "tests"]);

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (skip.has(name)) return [];
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx|js|mjs)$/.test(name) ? [full] : [];
    });
  }

  it("is loaded only through lib/pf/guard", () => {
    const importers = sourceFiles(root)
      .filter((f) => /lib\/pf\/data["']|\.\/data["']/.test(readFileSync(f, "utf-8")))
      .map((f) => relative(root, f));
    expect(importers).toEqual(["lib/pf/guard.ts"]);
  });
});
