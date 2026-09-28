import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintOffersToken } from "@/lib/outreach/offersToken";
import { mintUnsubscribeToken } from "@/lib/outreach/unsubscribeToken";
import { OFFERS_CONSENT_TEXT, OFFERS_PAGE_VERSION } from "@/lib/outreach/offersPage";

const SECRET = "test-secret-not-a-real-one";
const PROSPECT_ID = 25386;
const EMAIL = "Pino@Example.com";

// A stand-in for the shared Supabase project. `rpc` models
// supabase/crm/007_offers_opt_in.sql rather than returning a constant: it
// refuses a suppressed address, writes one consent row and one event on the
// first yes, and nothing on a repeat. That is the behaviour under test.
const db = vi.hoisted(() => {
  type Prospect = {
    id: number;
    email: string | null;
    status: string;
    marketing_opt_in: boolean;
    opt_in_source: string | null;
    opt_in_at: string | null;
  };
  const state = {
    prospects: new Map<number, Prospect>(),
    suppression: new Set<string>(),
    consents: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
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
      if (state.rpcData) return { data: state.rpcData, error: null };

      const row = state.prospects.get(args.p_prospect_id as number)!;
      const email = (row.email ?? "").trim().toLowerCase() || null;
      if (!email) {
        return { data: { opted_in: false, already: false, refused: null, email_present: false }, error: null };
      }
      if (["suppressed", "dead"].includes(row.status) || state.suppression.has(email)) {
        return { data: { opted_in: false, already: false, refused: "suppressed", email_present: true }, error: null };
      }
      if (row.marketing_opt_in && row.opt_in_source === "explicit_yes") {
        return {
          data: { opted_in: false, already: true, refused: null, email_present: true, opted_in_at: row.opt_in_at },
          error: null,
        };
      }
      const at = "2026-09-27T23:42:00Z";
      Object.assign(row, { marketing_opt_in: true, opt_in_source: "explicit_yes", opt_in_at: at });
      state.consents.push({
        prospect_id: row.id,
        email,
        method: "offers_button",
        consent_text: args.p_consent_text,
        page_version: args.p_page_version,
        ip: args.p_ip,
        user_agent: args.p_user_agent,
      });
      state.events.push({ prospect_id: row.id, event: "opted_in" });
      return { data: { opted_in: true, already: false, refused: null, email_present: true, opted_in_at: at }, error: null };
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
  db.state.prospects = new Map([
    [
      PROSPECT_ID,
      {
        id: PROSPECT_ID,
        email: EMAIL,
        status: "sequenced",
        marketing_opt_in: false,
        opt_in_source: null,
        opt_in_at: null,
      },
    ],
  ]);
  db.state.suppression = new Set();
  db.state.consents = [];
  db.state.events = [];
  db.state.rpcCalls = [];
  db.state.selectError = null;
  db.state.rpcError = null;
  db.state.rpcData = null;
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
    expect(db.state.consents).toHaveLength(0);
  });
});

describe("POST — the button", () => {
  it("records exactly one consent row with the proof, and confirms", async () => {
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
    expect(db.state.consents).toHaveLength(1);
    expect(db.state.consents[0]).toMatchObject({
      email: "pino@example.com",
      method: "offers_button",
      consent_text: OFFERS_CONSENT_TEXT,
    });
    expect(db.state.events).toEqual([{ prospect_id: PROSPECT_ID, event: "opted_in" }]);
  });

  it("falls back to x-real-ip, and to nulls when there is nothing", async () => {
    await POST(buttonPost(token, { "x-real-ip": "198.51.100.4" }), ctx(token));
    expect(db.state.rpcCalls[0]).toMatchObject({ p_ip: "198.51.100.4", p_user_agent: null });

    db.state.prospects.get(PROSPECT_ID)!.marketing_opt_in = false;
    db.state.rpcCalls = [];
    await POST(buttonPost(token), ctx(token));
    expect(db.state.rpcCalls[0]).toMatchObject({ p_ip: null });
  });

  it("writes nothing on a repeat press and shows the first date", async () => {
    await POST(buttonPost(token), ctx(token));
    const second = await POST(buttonPost(token), ctx(token));

    expect(second.status).toBe(200);
    expect(await second.text()).toContain("on Sunday, September 27, 2026 at 7:42 PM ET.");
    expect(db.state.consents).toHaveLength(1);
    expect(db.state.events).toHaveLength(1);
  });

  it("upgrades a past booker's implied opt-in to an explicit one", async () => {
    Object.assign(db.state.prospects.get(PROSPECT_ID)!, {
      marketing_opt_in: true,
      opt_in_source: "booked",
      opt_in_at: "2025-01-01T00:00:00Z",
    });
    const response = await POST(buttonPost(token), ctx(token));

    expect(response.status).toBe(200);
    expect(db.state.consents).toHaveLength(1);
    expect(db.state.prospects.get(PROSPECT_ID)!.opt_in_source).toBe("explicit_yes");
  });

  it("refuses a suppressed address and writes nothing", async () => {
    db.state.suppression.add("pino@example.com");
    const response = await POST(buttonPost(token), ctx(token));

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("asked us to stop emailing it");
    expect(db.state.consents).toHaveLength(0);
    expect(db.state.events).toHaveLength(0);
  });

  it("only the page's own form counts as the button", async () => {
    for (const body of ["", "List-Unsubscribe=One-Click", "via=other"]) {
      const response = await POST(buttonPost(token, {}, body), ctx(token));
      expect(response.status).toBe(400);
    }
    expect(db.state.rpcCalls).toHaveLength(0);
  });

  it("404s when the RPC finds no address on the row", async () => {
    db.state.rpcData = { opted_in: false, email_present: false };
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
