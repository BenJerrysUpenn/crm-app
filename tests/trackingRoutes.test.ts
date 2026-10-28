import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintClickToken, mintOpenToken } from "@/lib/outreach/trackingToken";
import { mintOffersToken } from "@/lib/outreach/offersToken";
import { mintUnsubscribeToken } from "@/lib/outreach/unsubscribeToken";

const SECRET = "test-secret-not-a-real-one";
const PROSPECT_ID = 25386;
const EMAIL = "Remy@Example.com";
const TID = "0123456789abcdef";
const DEST = "https://crm.withers-ventures.com/offers/abc?x=1&y=two";

// A stand-in for the shared Supabase project: one prospects lookup and the
// outreach_events insert, with switches for each way the database can fail.
const db = vi.hoisted(() => {
  const state = {
    prospects: new Map<number, { id: number; email: string | null }>(),
    events: [] as Array<Record<string, unknown>>,
    lookups: 0,
    selectError: null as { message: string } | null,
    selectThrows: false,
    insertError: null as { message: string } | null,
    insertThrows: false,
  };

  const client = {
    from(table: string) {
      if (table === "outreach_prospects") {
        let wanted: number | null = null;
        const builder = {
          select: () => builder,
          eq: (_col: string, value: number) => {
            wanted = value;
            return builder;
          },
          maybeSingle: async () => {
            state.lookups++;
            if (state.selectThrows) throw new Error("network down");
            if (state.selectError) return { data: null, error: state.selectError };
            const row = wanted === null ? undefined : state.prospects.get(wanted);
            return { data: row ?? null, error: null };
          },
        };
        return builder;
      }
      if (table === "outreach_events") {
        return {
          insert: async (row: Record<string, unknown>) => {
            if (state.insertThrows) throw new Error("network down");
            if (state.insertError) return { data: null, error: state.insertError };
            state.events.push(row);
            return { data: null, error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { state, client };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => db.client,
}));

const { GET: openGET } = await import("@/app/api/t/o/[token]/route");
const { GET: clickGET } = await import("@/app/api/t/c/[token]/route");

function ctx(token: string) {
  return { params: { token } };
}

function openRequest(token: string, headers: Record<string, string> = {}) {
  return new Request(`https://crm.test/api/t/o/${token}`, { headers });
}

function clickRequest(
  token: string,
  u: string | null,
  headers: Record<string, string> = {},
) {
  const query = u === null ? "" : `?u=${encodeURIComponent(u)}`;
  return new Request(`https://crm.test/api/t/c/${token}${query}`, { headers });
}

const GIF_BYTES = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

async function expectPixel(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/gif");
  expect(response.headers.get("cache-control")).toBe(
    "no-store, no-cache, must-revalidate, private",
  );
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("location")).toBeNull();
  expect(Buffer.from(await response.arrayBuffer()).equals(GIF_BYTES)).toBe(true);
}

let openToken: string;
let clickToken: string;
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.UNSUBSCRIBE_SECRET = SECRET;
  db.state.prospects = new Map([[PROSPECT_ID, { id: PROSPECT_ID, email: EMAIL }]]);
  db.state.events = [];
  db.state.lookups = 0;
  db.state.selectError = null;
  db.state.selectThrows = false;
  db.state.insertError = null;
  db.state.insertThrows = false;
  openToken = mintOpenToken(PROSPECT_ID, TID, EMAIL, SECRET);
  clickToken = mintClickToken(PROSPECT_ID, TID, EMAIL, DEST, SECRET);
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/t/o/<token> — the open pixel", () => {
  it("answers the GIF and writes exactly one 'opened' row", async () => {
    await expectPixel(
      await openGET(openRequest(openToken, { "user-agent": "Mozilla/5.0 (probe)" }), ctx(openToken)),
    );

    expect(db.state.events).toEqual([
      {
        prospect_id: PROSPECT_ID,
        event: "opened",
        detail: { tracking_id: TID, source: "pixel", user_agent: "Mozilla/5.0 (probe)" },
      },
    ]);
  });

  it("truncates the user agent to 300 characters and stores no IP", async () => {
    await openGET(
      openRequest(openToken, {
        "user-agent": "x".repeat(1000),
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "203.0.113.9",
      }),
      ctx(openToken),
    );

    const detail = db.state.events[0].detail as Record<string, unknown>;
    expect((detail.user_agent as string).length).toBe(300);
    expect(JSON.stringify(db.state.events[0])).not.toContain("203.0.113.9");
  });

  it("records a missing user agent as null", async () => {
    await openGET(openRequest(openToken), ctx(openToken));
    expect((db.state.events[0].detail as Record<string, unknown>).user_agent).toBeNull();
  });

  it("writes a row per fetch: proxies and re-opens are the reader's to filter", async () => {
    await openGET(openRequest(openToken), ctx(openToken));
    await openGET(openRequest(openToken), ctx(openToken));
    expect(db.state.events).toHaveLength(2);
  });

  const badTokens = (): Array<[string, string]> => [
    ["a bad MAC", mintOpenToken(PROSPECT_ID, TID, EMAIL, "a-different-secret")],
    ["another address", mintOpenToken(PROSPECT_ID, TID, "someone@example.org", SECRET)],
    ["an unknown prospect", mintOpenToken(999999, TID, EMAIL, SECRET)],
    ["a click token", mintClickToken(PROSPECT_ID, TID, EMAIL, DEST, SECRET)],
    ["an unsubscribe token", mintUnsubscribeToken(PROSPECT_ID, EMAIL, SECRET)],
    ["an offers token", mintOffersToken(PROSPECT_ID, EMAIL, SECRET)],
    ["a malformed token", "not-a-real-token"],
    ["an empty token", ""],
  ];

  it.each(badTokens())("still answers the GIF on %s, and writes nothing", async (_l, bad) => {
    await expectPixel(await openGET(openRequest(bad), ctx(bad)));
    expect(db.state.events).toHaveLength(0);
  });

  it("does not touch the database for a token that does not parse", async () => {
    await openGET(openRequest("not-a-real-token"), ctx("not-a-real-token"));
    expect(db.state.lookups).toBe(0);
  });

  it("answers the GIF with the secret unset, and never looks anything up", async () => {
    delete process.env.UNSUBSCRIBE_SECRET;
    await expectPixel(await openGET(openRequest(openToken), ctx(openToken)));
    expect(db.state.lookups).toBe(0);
    expect(db.state.events).toHaveLength(0);
  });

  it("answers the GIF when the prospect has no address", async () => {
    db.state.prospects.set(PROSPECT_ID, { id: PROSPECT_ID, email: null });
    await expectPixel(await openGET(openRequest(openToken), ctx(openToken)));
    expect(db.state.events).toHaveLength(0);
  });

  it.each([
    ["the lookup returns an error", () => (db.state.selectError = { message: "boom" })],
    ["the lookup throws", () => (db.state.selectThrows = true)],
    ["the insert returns an error", () => (db.state.insertError = { message: "check violation" })],
    ["the insert throws", () => (db.state.insertThrows = true)],
  ])("answers the GIF when %s, and logs it", async (_l, breakIt) => {
    breakIt();
    await expectPixel(await openGET(openRequest(openToken), ctx(openToken)));
    expect(errorLog).toHaveBeenCalled();
  });
});

describe("GET /api/t/c/<token>?u= — the click redirect", () => {
  it("writes one 'clicked' row and 302s to the exact destination", async () => {
    const response = await clickGET(
      clickRequest(clickToken, DEST, { "user-agent": "Mozilla/5.0 (probe)" }),
      ctx(clickToken),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(DEST);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    expect(db.state.events).toEqual([
      {
        prospect_id: PROSPECT_ID,
        event: "clicked",
        detail: {
          tracking_id: TID,
          url: DEST,
          source: "redirect",
          user_agent: "Mozilla/5.0 (probe)",
        },
      },
    ]);
  });

  it("truncates the user agent to 300 characters and stores no IP", async () => {
    await clickGET(
      clickRequest(clickToken, DEST, {
        "user-agent": "y".repeat(1000),
        "x-forwarded-for": "203.0.113.9",
      }),
      ctx(clickToken),
    );
    const detail = db.state.events[0].detail as Record<string, unknown>;
    expect((detail.user_agent as string).length).toBe(300);
    expect(JSON.stringify(db.state.events[0])).not.toContain("203.0.113.9");
  });

  it.each([
    ["the insert returns an error", () => (db.state.insertError = { message: "check violation" })],
    ["the insert throws", () => (db.state.insertThrows = true)],
  ])("still redirects when %s, and logs it", async (_l, breakIt) => {
    breakIt();
    const response = await clickGET(clickRequest(clickToken, DEST), ctx(clickToken));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(DEST);
    expect(errorLog).toHaveBeenCalled();
  });

  const otherDest = "https://evil.example/phish";
  const rejected = (): Array<[string, string, string | null]> => [
    ["a bad MAC", mintClickToken(PROSPECT_ID, TID, EMAIL, DEST, "a-different-secret"), DEST],
    ["another address", mintClickToken(PROSPECT_ID, TID, "someone@example.org", DEST, SECRET), DEST],
    ["an unknown prospect", mintClickToken(999999, TID, EMAIL, DEST, SECRET), DEST],
    ["a swapped destination", mintClickToken(PROSPECT_ID, TID, EMAIL, DEST, SECRET), otherDest],
    ["a missing u", mintClickToken(PROSPECT_ID, TID, EMAIL, DEST, SECRET), null],
    ["an empty u", mintClickToken(PROSPECT_ID, TID, EMAIL, "", SECRET), ""],
    ["a relative u, even correctly signed", mintClickToken(PROSPECT_ID, TID, EMAIL, "/login", SECRET), "/login"],
    ["a javascript: u, even correctly signed", mintClickToken(PROSPECT_ID, TID, EMAIL, "javascript:alert(1)", SECRET), "javascript:alert(1)"],
    ["a protocol-relative u, even correctly signed", mintClickToken(PROSPECT_ID, TID, EMAIL, "//evil.example/", SECRET), "//evil.example/"],
    ["an open token", mintOpenToken(PROSPECT_ID, TID, EMAIL, SECRET), DEST],
    ["an unsubscribe token", mintUnsubscribeToken(PROSPECT_ID, EMAIL, SECRET), DEST],
    ["an offers token", mintOffersToken(PROSPECT_ID, EMAIL, SECRET), DEST],
    ["a malformed token", "not-a-real-token", DEST],
    ["an empty token", "", DEST],
  ];

  it.each(rejected())("404s on %s, never redirects, writes nothing", async (_l, token, u) => {
    const response = await clickGET(clickRequest(token, u), ctx(token));

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await response.text()).toBe("Not found.\n");
    expect(db.state.events).toHaveLength(0);
  });

  it("gives an unknown prospect the same answer as a bad MAC", async () => {
    const unknown = mintClickToken(999999, TID, EMAIL, DEST, SECRET);
    const forged = mintClickToken(PROSPECT_ID, TID, EMAIL, DEST, "a-different-secret");
    const a = await clickGET(clickRequest(unknown, DEST), ctx(unknown));
    const b = await clickGET(clickRequest(forged, DEST), ctx(forged));

    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });

  it("checks the destination before it touches the database", async () => {
    await clickGET(clickRequest(clickToken, "/relative"), ctx(clickToken));
    expect(db.state.lookups).toBe(0);
  });

  it("503s with the secret unset, and never redirects", async () => {
    delete process.env.UNSUBSCRIBE_SECRET;
    const response = await clickGET(clickRequest(clickToken, DEST), ctx(clickToken));

    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe("Tracking is not configured.\n");
    expect(db.state.lookups).toBe(0);
  });

  it.each([
    ["returns an error", () => (db.state.selectError = { message: "boom" })],
    ["throws", () => (db.state.selectThrows = true)],
  ])("500s without redirecting when the lookup %s: nothing is verified", async (_l, breakIt) => {
    breakIt();
    const response = await clickGET(clickRequest(clickToken, DEST), ctx(clickToken));

    expect(response.status).toBe(500);
    expect(response.headers.get("location")).toBeNull();
    expect(db.state.events).toHaveLength(0);
  });
});
