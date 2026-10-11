// Category corrections on /money (bj-finance #223): validation, how saved
// corrections lay over the feed, the overrides table I/O, the POST route's
// access rules, and the /safe "categorized through" stamp. Supabase, the
// feed loader and the admin client are stood in for; nothing touches a
// database.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerRow, PfMeta } from "@/lib/pf/types";

const ALLOWED = "00000000-0000-0000-0000-0000000000a1";
const STAFF = "00000000-0000-0000-0000-0000000000b1";
const CATS = ["Groceries", "Household Employees ", "Restaurants & Bars"];

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  feed: null as unknown,
  inserted: [] as Record<string, unknown>[],
  insertError: null as null | { message: string; code?: string },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/pf/data", () => ({ loadPfData: async () => state.feed }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeDb(),
}));

function fakeDb(rows: unknown[] | null = [], readError: unknown = null) {
  return {
    from: () => ({
      select: () => ({
        order: async () => ({ data: rows, error: readError }),
      }),
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            if (state.insertError) return { data: null, error: state.insertError };
            state.inserted.push(row);
            return {
              data: { id: "new-1", created_at: "2026-10-11T12:00:00Z", ...row },
              error: null,
            };
          },
        }),
      }),
    }),
  };
}

const {
  applyOverrides,
  loadOverrides,
  merchantKey,
  parseOverrideInput,
  saveOverride,
} = await import("@/lib/pf/overrides");
const { POST } = await import("@/app/api/pf/overrides/route");
const { categorizedStamp } = await import("@/components/pf/MetaBanner");

const row = (over: Partial<ExplorerRow> = {}): ExplorerRow => ({
  d: "2026-10-01",
  m: "Corner Store",
  a: -12.5,
  g: "food",
  s: "Groceries",
  g2: "habit",
  s2: "Groceries",
  id: "t1",
  c: "Groceries",
  ...over,
});

const good = {
  scope: "merchant",
  txn_id: "t1",
  merchant: "Corner Store",
  category: "Household Employees ",
};

function feedWith(categories?: string[]) {
  return {
    ok: true,
    data: { meta: { categories }, explorer: { rows: [] } },
  };
}

function post(body: unknown) {
  return POST(
    new Request("http://x/api/pf/overrides", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.user = null;
  state.feed = feedWith(CATS);
  state.inserted = [];
  state.insertError = null;
  vi.stubEnv("PF_ALLOWED_USER_IDS", ALLOWED);
});
afterEach(() => vi.unstubAllEnvs());

describe("parseOverrideInput", () => {
  it("accepts a merchant correction and keeps the category byte for byte", () => {
    const r = parseOverrideInput(good, CATS);
    expect(r).toEqual({ ok: true, input: { ...good, scope: "merchant" } });
  });

  it.each([
    [null, "Bad body"],
    [{ ...good, scope: "all" }, "scope"],
    [{ ...good, txn_id: "" }, "txn_id"],
    [{ ...good, txn_id: 7 }, "txn_id"],
    [{ ...good, txn_id: "x".repeat(65) }, "txn_id"],
    [{ ...good, merchant: "  " }, "merchant"],
    [{ ...good, merchant: "m".repeat(201) }, "merchant"],
    [{ ...good, category: "Household Employees" }, "category"],
    [{ ...good, category: 3 }, "category"],
  ])("refuses %j", (body, why) => {
    const r = parseOverrideInput(body, CATS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(why);
  });
});

describe("applyOverrides", () => {
  const o = (over: Record<string, unknown>) => ({
    id: "o",
    scope: "merchant" as const,
    txn_id: null,
    merchant: "Corner Store",
    category: "Restaurants & Bars",
    created_at: "2026-10-02T00:00:00Z",
    ...over,
  });

  it("matches merchants on the feed's 38-character, case-blind name", () => {
    expect(merchantKey("  CORNER STORE ")).toBe("corner store");
    const [r] = applyOverrides([row({ m: "corner store" })], [o({})]);
    expect(r.c).toBe("Restaurants & Bars");
    expect((r as { corrected?: string }).corrected).toBe("merchant");
  });

  it("lets a transaction correction beat a merchant one, and newest win", () => {
    const rows = applyOverrides(
      [row(), row({ id: "t2" })],
      [
        o({ id: "late", created_at: "2026-10-05T00:00:00Z", category: "Groceries" }),
        o({ id: "early", created_at: "2026-10-01T00:00:00Z" }),
        o({ id: "txn", scope: "transaction", txn_id: "t2", category: "Household Employees " }),
        o({ id: "tie", created_at: "2026-10-05T00:00:00Z", category: "Groceries" }),
      ],
    );
    // t1: the newest merchant correction is Groceries, already its category
    expect(rows[0]).toEqual(row());
    expect(rows[1].c).toBe("Household Employees ");
  });

  it("leaves rows without an id (aggregated 401k rows) alone", () => {
    const r = row({ id: undefined });
    expect(applyOverrides([r], [o({})])[0]).toBe(r);
  });

  it("ignores a transaction correction that lost its id", () => {
    const r = row({ m: "Elsewhere" });
    expect(
      applyOverrides([r], [o({ scope: "transaction", txn_id: null })])[0],
    ).toBe(r);
  });
});

describe("the overrides table", () => {
  it("reads every correction, and none when the read fails", async () => {
    const one = [{ id: "a" }];
    expect(await loadOverrides(fakeDb(one) as never)).toEqual(one);
    expect(await loadOverrides(fakeDb(null) as never)).toEqual([]);
    expect(
      await loadOverrides(fakeDb([], { message: "relation does not exist" }) as never),
    ).toEqual([]);
  });

  it("saves with the caller's id and names a missing table", async () => {
    const input = { ...good, scope: "merchant" as const };
    const ok = await saveOverride(fakeDb() as never, input, ALLOWED);
    expect(ok.ok).toBe(true);
    expect(state.inserted[0]).toMatchObject({ created_by: ALLOWED, ...input });

    for (const code of ["42P01", "PGRST205"]) {
      state.insertError = { message: "no table", code };
      const r = await saveOverride(fakeDb() as never, input, ALLOWED);
      expect(r).toMatchObject({ ok: false, reason: "missing_table" });
    }
    state.insertError = { message: "boom" };
    expect(await saveOverride(fakeDb() as never, input, ALLOWED)).toMatchObject({
      ok: false,
      reason: "failed",
    });
  });
});

describe("POST /api/pf/overrides", () => {
  it("is 401 signed out and 404 for anyone not on the allowlist", async () => {
    expect((await post(good)).status).toBe(401);
    state.user = { id: STAFF, email: "s@example.test" };
    expect((await post(good)).status).toBe(404);
    expect(state.inserted).toEqual([]);
  });

  it("saves an allowed user's correction", async () => {
    state.user = { id: ALLOWED, email: "a@example.test" };
    const res = await post(good);
    expect(res.status).toBe(201);
    expect((await res.json()).override.category).toBe("Household Employees ");
    expect(state.inserted[0]).toMatchObject({ created_by: ALLOWED });
  });

  it("refuses bad JSON, bad input and a feed without categories", async () => {
    state.user = { id: ALLOWED, email: "a@example.test" };
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ ...good, category: "Snacks" })).status).toBe(400);
    state.feed = feedWith(undefined);
    expect((await post(good)).status).toBe(409);
    state.feed = { ok: false, reason: "missing" };
    expect((await post(good)).status).toBe(409);
    expect(state.inserted).toEqual([]);
  });

  it("says when the table is not there yet, and when the write fails", async () => {
    state.user = { id: ALLOWED, email: "a@example.test" };
    state.insertError = { message: "missing", code: "42P01" };
    const pending = await post(good);
    expect(pending.status).toBe(503);
    expect((await pending.json()).error).toContain("not switched on yet");
    state.insertError = { message: "boom" };
    expect((await post(good)).status).toBe(500);
  });
});

describe("categorized-through stamp", () => {
  const meta = (through?: string | null) =>
    ({ categorized_through: through }) as PfMeta;

  it("names the day the pass has reached", () => {
    expect(categorizedStamp(meta("2026-10-09"))).toBe(
      "Categorized through Oct 9, 2026",
    );
  });

  it("says so before the first pass", () => {
    expect(categorizedStamp(meta(null))).toMatch(/not categorized/i);
    expect(categorizedStamp(meta(undefined))).toMatch(/not categorized/i);
  });

  it("passes an unparseable date through", () => {
    expect(categorizedStamp(meta("someday"))).toBe("Categorized through someday");
  });
});
