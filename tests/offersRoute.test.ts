import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintOffersToken } from "@/lib/outreach/offersToken";
import { mintUnsubscribeToken } from "@/lib/outreach/unsubscribeToken";
import { OFFERS_CONSENT_TEXT, OFFERS_PAGE_VERSION } from "@/lib/outreach/offersPage";

const SECRET = "test-secret-not-a-real-one";
const PROSPECT_ID = 25386;
const EMAIL = "Pino@Example.com";

// A stand-in for the shared Supabase project, at the database boundary only.
// The prospect lookup reads a table; the RPC answers with a canned outcome in
// the exact shape supabase/crm/007_offers_opt_in.sql returns (its RETURN
// jsonb_build_object lines). The SQL's own decisions (idempotency, lifting a
// suppression, the booked -> explicit_yes upgrade) are not re-implemented
// here: a TypeScript copy of them would only test itself. What is under test
// is what the route does with each outcome the function can return.
const OUTCOME = {
  firstYes: {
    opted_in: true, already: false, refused: null, email_present: true,
    lifted: false, opted_in_at: "2026-09-27T23:42:00Z",
  },
  yesLiftingSuppression: {
    opted_in: true, already: false, refused: null, email_present: true,
    lifted: true, opted_in_at: "2026-09-27T23:42:00Z",
  },
  repeat: {
    opted_in: false, already: true, refused: null, email_present: true,
    lifted: false, opted_in_at: "2026-09-20T14:05:00Z",
  },
  dead: {
    opted_in: false, already: false, refused: "dead", email_present: true,
    lifted: false, opted_in_at: null,
  },
  noEmail: {
    opted_in: false, already: false, refused: null, email_present: false,
    lifted: false, opted_in_at: null,
  },
} as const;

const db = vi.hoisted(() => {
  const state = {
    prospects: new Map<number, { id: number; email: string | null }>(),
    rpcCalls: [] as Array<Record<string, unknown>>,
    selectError: null as { message: string } | null,
    rpcError: null as { message: string } | null,
    rpcData: null as Record<string, unknown> | null,
  };

  const client = {
    from(table: string) {
      if (table !== "outreach_prospects") throw new Error(`unexpected table ${table}`);
      let wanted: number | null = null;
      const builder = {
        select: () => builder,
        eq: (_col: string, value: number) => {
          wanted = value;
          return builder;
        },
        maybeSingle: async () => {
          if (state.selectError) return { data: null, error: state.selectError };
          const row = wanted === null ? undefined : state.prospects.get(wanted);
          return { data: row ? { id: row.id, email: row.email } : null, error: null };
        },
      };
      return builder;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ name, ...args });
      if (state.rpcError) return { data: null, error: state.rpcError };
      return { data: state.rpcData, error: null };
    },
  };

  return { state, client };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => db.client,
}));

const { GET, POST } = await import("@/app/offers/[token]/route");

const ctx = (token: string) => ({ params: { token } });

function buttonPost(token: string, headers: Record<string, string> = {}, body = "via=link") {
  return new Request(`https://crm.test/offers/${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

const getRequest = (token: string) => new Request(`https://crm.test/offers/${token}`);

let token: string;

beforeEach(() => {
  process.env.UNSUBSCRIBE_SECRET = SECRET;
  db.state.prospects = new Map([[PROSPECT_ID, { id: PROSPECT_ID, email: EMAIL }]]);
  db.state.rpcCalls = [];
  db.state.selectError = null;
  db.state.rpcError = null;
  db.state.rpcData = { ...OUTCOME.firstYes };
  token = mintOffersToken(PROSPECT_ID, EMAIL, SECRET);
});

describe("GET — the page the footer link lands on", () => {
  it("renders the approved copy and one button, and writes nothing", async () => {
    const response = await GET(getRequest(token), ctx(token));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(body).toContain("<h1>One seasonal menu a month?</h1>");
    expect(body).toContain("Pino@Example.com");
    expect(body).toContain("Nothing is signed up until you do.");
    expect(body).toContain('<form method="post">');
    expect(body).toContain('<button type="submit">Yes, send me offers</button>');
    expect(body).not.toContain("action=");

    expect(db.state.rpcCalls).toHaveLength(0);
  });
});

describe("POST — the button", () => {
  it("records the consent with its proof in one call, and confirms", async () => {
    const response = await POST(
      buttonPost(token, {
        "user-agent": "Mozilla/5.0 (probe)",
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      }),
      ctx(token),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(body).toContain("<h1>You're on the list</h1>");
    expect(body).toContain("Sent to Pino@Example.com.");
    expect(body).toContain("Agreed by Pino@Example.com on Sunday, September 27, 2026 at 7:42 PM ET.");

    expect(db.state.rpcCalls).toEqual([
      {
        name: "outreach_offers_opt_in",
        p_prospect_id: PROSPECT_ID,
        p_consent_text: OFFERS_CONSENT_TEXT,
        p_page_version: OFFERS_PAGE_VERSION,
        p_ip: "203.0.113.9",
        p_user_agent: "Mozilla/5.0 (probe)",
      },
    ]);
  });

  it("falls back to x-real-ip, and to nulls when there is nothing", async () => {
    await POST(buttonPost(token, { "x-real-ip": "198.51.100.4" }), ctx(token));
    expect(db.state.rpcCalls[0]).toMatchObject({ p_ip: "198.51.100.4", p_user_agent: null });

    db.state.rpcCalls = [];
    await POST(buttonPost(token), ctx(token));
    expect(db.state.rpcCalls[0]).toMatchObject({ p_ip: null });
  });

  it("confirms a repeat press with the date they first said yes", async () => {
    db.state.rpcData = { ...OUTCOME.repeat };
    const response = await POST(buttonPost(token), ctx(token));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "Agreed by Pino@Example.com on Sunday, September 20, 2026 at 10:05 AM ET.",
    );
  });

  it("shows a previously suppressed address the same confirmation", async () => {
    // Owners' ruling 2026-09-27: an opt-in after a suppression is an opt-in.
    db.state.rpcData = { ...OUTCOME.yesLiftingSuppression };
    const response = await POST(buttonPost(token), ctx(token));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<h1>You're on the list</h1>");
    expect(body).toContain("Agreed by Pino@Example.com on Sunday, September 27, 2026 at 7:42 PM ET.");
  });

  it("404s a dead (test or invalid) row like any other bad link", async () => {
    db.state.rpcData = { ...OUTCOME.dead };
    const response = await POST(buttonPost(token), ctx(token));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found.\n");
  });

  it("only the page's own form counts as the button", async () => {
    for (const body of ["", "List-Unsubscribe=One-Click", "via=other"]) {
      const response = await POST(buttonPost(token, {}, body), ctx(token));
      expect(response.status).toBe(400);
    }
    expect(db.state.rpcCalls).toHaveLength(0);
  });

  it("404s when the RPC finds no address on the row", async () => {
    db.state.rpcData = { ...OUTCOME.noEmail };
    const response = await POST(buttonPost(token), ctx(token));
    expect(response.status).toBe(404);
  });
});

describe("rejected tokens", () => {
  const badTokens = (): Array<[string, string]> => [
    ["an UNSUBSCRIBE token for the same person", mintUnsubscribeToken(PROSPECT_ID, EMAIL, SECRET)],
    ["a bad MAC", mintOffersToken(PROSPECT_ID, EMAIL, "a-different-secret")],
    ["another prospect's address", mintOffersToken(PROSPECT_ID, "someone@else.com", SECRET)],
    ["an unknown prospect id", mintOffersToken(999999, EMAIL, SECRET)],
    ["a malformed token", "not-a-real-token"],
  ];

  it.each(badTokens())("POST 404s on %s and writes nothing", async (_label, bad) => {
    const response = await POST(buttonPost(bad), ctx(bad));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found.\n");
    expect(db.state.rpcCalls).toHaveLength(0);
  });

  it.each(badTokens())("GET 404s on %s", async (_label, bad) => {
    const response = await GET(getRequest(bad), ctx(bad));
    expect(response.status).toBe(404);
  });

  it("404s a row with no address", async () => {
    db.state.prospects.get(PROSPECT_ID)!.email = null;
    const response = await GET(getRequest(token), ctx(token));
    expect(response.status).toBe(404);
  });
});

describe("failure modes", () => {
  it("503s when UNSUBSCRIBE_SECRET is unset, rather than a silent 404", async () => {
    delete process.env.UNSUBSCRIBE_SECRET;
    const get = await GET(getRequest(token), ctx(token));
    const post = await POST(buttonPost(token), ctx(token));

    expect(get.status).toBe(503);
    expect(post.status).toBe(503);
    expect(db.state.rpcCalls).toHaveLength(0);
  });

  it("500s on a lookup error", async () => {
    db.state.selectError = { message: "boom" };
    const response = await GET(getRequest(token), ctx(token));
    expect(response.status).toBe(500);
  });

  it("500s on an RPC error", async () => {
    db.state.rpcError = { message: "boom" };
    const response = await POST(buttonPost(token), ctx(token));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Offers sign-up failed.\n");
  });
});
