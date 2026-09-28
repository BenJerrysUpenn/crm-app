// The owner role in the CRM (time-app migration 31).
//
//   * The personal-finance pages (/money, /dial, /safe) are for owners only:
//     an owner gets in, a manager and an employee do not. Checked at the
//     middleware gate AND on the page, before the feed is read.
//   * Everywhere else an owner passes the manager gate.
//   * Nothing looks at profiles.active (audit H2).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import { crmAccess, isManagerRole, isOwnerRole, isPfPath } from "@/lib/roles";

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
      const row = who.user ? { role: who.role, active: who.active } : null;
      const b = {
        select: () => b,
        eq: () => b,
        single: async () => ({ data: row, error: null }),
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return b;
    },
  };
}

vi.mock("@supabase/ssr", () => ({ createServerClient: () => fakeClient() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => fakeClient() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { updateSession } = await import("@/lib/supabase/middleware");
const { requirePfOwner } = await import("@/lib/pf/access");

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

  it("crmAccess: PF for owners only, the rest for managers and owners", () => {
    expect(crmAccess("/money", "owner")).toBe("allowed");
    expect(crmAccess("/money", "manager")).toBe("refused");
    expect(crmAccess("/money", "employee")).toBe("refused");
    expect(crmAccess("/", "owner")).toBe("allowed");
    expect(crmAccess("/", "manager")).toBe("allowed");
    expect(crmAccess("/", "employee")).toBe("refused");
    expect(crmAccess("/", null)).toBe("refused");
  });
});

describe("the middleware gate", () => {
  it.each(["/money", "/dial", "/safe"])("lets an owner into %s", async (p) => {
    signIn("owner", false);
    expect(await gate(p)).toBe("through");
  });

  it.each(["/money", "/dial", "/safe"])("sends a manager from %s to /no-access", async (p) => {
    signIn("manager");
    expect(await gate(p)).toBe("/no-access");
  });

  it.each(["/money", "/dial", "/safe"])("sends an employee from %s to /no-access", async (p) => {
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

describe("the page-level check (requirePfOwner)", () => {
  it("returns the owner's email", async () => {
    signIn("owner", false);
    await expect(requirePfOwner()).resolves.toEqual({ email: "someone@example.test" });
  });

  it.each(["manager", "employee", null])("refuses role %s", async (role) => {
    signIn(role);
    await expect(requirePfOwner()).rejects.toThrow("REDIRECT /no-access");
  });

  it("sends nobody-signed-in to /login", async () => {
    await expect(requirePfOwner()).rejects.toThrow("REDIRECT /login");
  });

  it.each(["money", "dial", "safe"])("app/%s/page.tsx checks for an owner before reading the feed", (p) => {
    const src = readFileSync(join(__dirname, "..", "app", p, "page.tsx"), "utf8");
    const check = src.indexOf("await requirePfOwner()");
    const feed = src.indexOf("loadPfData()", src.indexOf("export default"));
    expect(check).toBeGreaterThan(0);
    expect(feed).toBeGreaterThan(check);
  });

  it("nothing else reads the feed", () => {
    // The three pages above are the only importers of loadPfData.
    const root = join(__dirname, "..");
    const callers = ["app", "lib", "components"]
      .flatMap((d) =>
        (readdirSync(join(root, d), { recursive: true }) as string[])
          .filter((f) => /\.(ts|tsx)$/.test(f))
          .map((f) => join(d, f)),
      )
      .filter((f) => /import[^;]*\bloadPfData\b/.test(readFileSync(join(root, f), "utf8")))
      .sort();
    expect(callers).toEqual([
      join("app", "dial", "page.tsx"),
      join("app", "money", "page.tsx"),
      join("app", "safe", "page.tsx"),
    ]);
  });
});
