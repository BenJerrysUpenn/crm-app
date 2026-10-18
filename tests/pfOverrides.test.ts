// Category corrections on /money (bj-finance #223): validation, how saved
// corrections lay over the feed, the overrides table I/O, the POST route's
// access rules, and the /safe "categorized through" stamp. Supabase (auth and
// the admin client) and Next's navigation throws are stood in for; nothing
// touches a database. The feed is read by the real loader from a synthetic
// file (PF_DATA_PATH): the committed sample, or a copy of it with
// meta.categories removed.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CorrectedRow } from "@/lib/pf/overrides";
import type { ExplorerRow, PfMeta } from "@/lib/pf/types";

const ALLOWED = "00000000-0000-0000-0000-0000000000a1";
const STAFF = "00000000-0000-0000-0000-0000000000b1";
const CATS = ["Groceries", "Household Employees ", "Restaurants & Bars"];

// The committed synthetic feed (its meta.categories includes the trailing-
// space "Household Employees ", and categorized_through is 2026-08-14), and
// a copy of it published before #223, with no category list.
const SAMPLE_FEED = resolve(__dirname, "../fixtures/pf_data.sample.json");
const FEED_WITHOUT_CATEGORIES = (() => {
  const feed = JSON.parse(readFileSync(SAMPLE_FEED, "utf-8"));
  delete feed.meta.categories;
  const path = join(mkdtempSync(join(tmpdir(), "pf-feed-")), "pf_data.json");
  writeFileSync(path, JSON.stringify(feed));
  return path;
})();

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  role: "owner" as string | null,
  inserted: [] as Record<string, unknown>[],
  insertError: null as null | { message: string; code?: string },
  saved: [] as unknown[],
  readError: null as unknown,
}));

// The server client lib/pf/access reads: the signed-in user, then that user's
// profiles.role (owner-only gate, time-app migration 42).
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: state.user ? { role: state.role } : null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  usePathname: () => "/safe",
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeDb(state.saved, state.readError),
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
const SafePage = (await import("@/app/safe/page")).default;
const MoneyPage = (await import("@/app/money/page")).default;

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
  state.role = "owner";
  state.inserted = [];
  state.insertError = null;
  state.saved = [];
  state.readError = null;
  vi.stubEnv("PF_DATA_PATH", SAMPLE_FEED);
  vi.stubEnv("PF_GITHUB_TOKEN", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("parseOverrideInput", () => {
  it("accepts a merchant correction and keeps the category byte for byte", () => {
    const r = parseOverrideInput(good, CATS);
    expect(r).toEqual({ ok: true, input: { ...good, scope: "merchant" } });
  });

  it("accepts a just-this-one correction, trimming the id and merchant", () => {
    const r = parseOverrideInput(
      { ...good, scope: "transaction", txn_id: " t9 ", merchant: " Corner Store " },
      CATS,
    );
    expect(r).toEqual({
      ok: true,
      input: {
        scope: "transaction",
        txn_id: "t9",
        merchant: "Corner Store",
        category: "Household Employees ",
      },
    });
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

  it("matches a merchant on its first 38 characters, as the feed truncates it", () => {
    const full = "Fixture Neighbourhood Hardware & Garden Supply Co";
    expect(merchantKey(full)).toBe("fixture neighbourhood hardware & garde");
    const [r] = applyOverrides(
      [row({ m: "Fixture Neighbourhood Hardware & Garde" })],
      [o({ merchant: full })],
    );
    expect(r.c).toBe("Restaurants & Bars");
  });

  it("lets the newest merchant correction win, whatever order they arrive in", () => {
    const [r] = applyOverrides(
      [row()],
      [
        o({ id: "late", created_at: "2026-10-05T00:00:00Z", category: "Household Employees " }),
        o({ id: "early", created_at: "2026-10-01T00:00:00Z", category: "Restaurants & Bars" }),
      ],
    );
    expect(r.c).toBe("Household Employees ");
  });

  it("lets a transaction correction beat a newer merchant one", () => {
    const rows = applyOverrides(
      [row(), row({ id: "t2" })],
      [
        o({ id: "txn", scope: "transaction", txn_id: "t2", category: "Household Employees ", created_at: "2026-10-01T00:00:00Z" }),
        o({ id: "merchant", created_at: "2026-10-05T00:00:00Z", category: "Restaurants & Bars" }),
      ],
    );
    expect(rows[0]).toMatchObject({ c: "Restaurants & Bars", corrected: "merchant" });
    expect(rows[1]).toMatchObject({ c: "Household Employees ", corrected: "transaction" });
  });

  it("leaves a row unflagged when the correction names the category it already has", () => {
    const r = row();
    expect(applyOverrides([r], [o({ category: "Groceries" })])[0]).toEqual(r);
  });

  it("leaves rows without an id (aggregated 401k rows) alone", () => {
    const r = row({ id: undefined });
    expect(applyOverrides([r], [o({})])[0]).toBe(r);
  });

  it("does not widen a transaction correction that lost its id to the whole merchant", () => {
    const r = row();
    expect(
      applyOverrides([r], [o({ scope: "transaction", txn_id: null })])[0],
    ).toBe(r);
  });
});

describe("the overrides table", () => {
  it("reads every correction, and none when the table returns no rows", async () => {
    const one = [{ id: "a" }];
    expect(await loadOverrides(fakeDb(one) as never)).toEqual(one);
    expect(await loadOverrides(fakeDb(null) as never)).toEqual([]);
  });

  it("is silent when the table is not there yet, loud on any other error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // Before crm/011 is applied: expected, no log.
    expect(
      await loadOverrides(
        fakeDb([], { message: "does not exist", code: "42P01" }) as never,
      ),
    ).toEqual([]);
    expect(
      await loadOverrides(
        fakeDb([], { message: "schema cache", code: "PGRST205" }) as never,
      ),
    ).toEqual([]);
    expect(err).not.toHaveBeenCalled();
    // A permission or network error must not pass unnoticed.
    expect(
      await loadOverrides(
        fakeDb([], { message: "permission denied", code: "42501" }) as never,
      ),
    ).toEqual([]);
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
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
  it("is 401 signed out and 404 for anyone who is not an owner", async () => {
    expect((await post(good)).status).toBe(401);
    state.user = { id: STAFF, email: "s@example.test" };
    state.role = "manager";
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
    vi.stubEnv("PF_DATA_PATH", FEED_WITHOUT_CATEGORIES);
    expect((await post(good)).status).toBe(409);
    vi.stubEnv("PF_DATA_PATH", "");
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

describe("the pages", () => {
  const render = async (page: () => Promise<unknown>) => {
    state.user = { id: ALLOWED, email: "a@example.test" };
    return renderToStaticMarkup((await page()) as Parameters<typeof renderToStaticMarkup>[0]);
  };

  it("shows the categorized-through stamp on /safe, from the feed", async () => {
    expect(await render(SafePage)).toContain("Categorized through Aug 14, 2026");
  });

  it("does not show the stamp on /money", async () => {
    expect(await render(MoneyPage)).not.toContain("Categorized through");
  });

  // The explorer only draws a row's category once a merchant is clicked, so a
  // static render cannot show it. What /money hands the explorer is the
  // server-to-client boundary: the rows serialised to the browser.
  const rowsSentToExplorer = (node: unknown): CorrectedRow[] | null => {
    if (!node || typeof node !== "object") return null;
    const props = (node as { props?: Record<string, unknown> }).props;
    if (!props) return null;
    const data = props.data as { rows?: CorrectedRow[] } | undefined;
    if (Array.isArray(data?.rows)) return data.rows;
    const kids = props.children;
    for (const kid of Array.isArray(kids) ? kids : [kids]) {
      const found = rowsSentToExplorer(kid);
      if (found) return found;
    }
    return null;
  };

  it("lays a saved correction over the row's category on /money before the next pass", async () => {
    state.user = { id: ALLOWED, email: "a@example.test" };
    state.saved = [
      {
        id: "o1",
        scope: "transaction",
        txn_id: "fx-003",
        merchant: "Fixture Brokerage",
        category: "Dividends & Capital Gains",
        created_at: "2026-10-02T00:00:00Z",
      },
    ];
    const rows = rowsSentToExplorer(await MoneyPage());
    expect(rows?.find((r) => r.id === "fx-003")).toMatchObject({
      c: "Dividends & Capital Gains",
      corrected: "transaction",
    });
    expect(rows?.find((r) => r.id === "fx-001")?.c).toBe("Paychecks");
  });

  it("still renders /money before crm/011 exists (no corrections table)", async () => {
    state.readError = { message: "does not exist", code: "42P01" };
    expect(await render(MoneyPage)).toContain("Data as of");
  });
});
