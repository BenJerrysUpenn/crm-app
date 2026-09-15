import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintUnsubscribeToken } from "@/lib/outreach/unsubscribeToken";

const SECRET = "test-secret-not-a-real-one";
const PROSPECT_ID = 25386;
const EMAIL = "Pino@Example.com";

// A stand-in for the shared Supabase project, small enough to read in one go.
// `rpc` mirrors supabase/crm/005_unsubscribe.sql: the suppression insert is
// ON CONFLICT DO NOTHING, and the event row and the status change happen only
// when that insert actually inserted. That is the behaviour under test, so it
// is modelled here rather than stubbed to a constant.
const db = vi.hoisted(() => {
  const state = {
    prospects: new Map<number, { id: number; email: string | null }>(),
    suppression: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    rpcCalls: [] as Array<Record<string, unknown>>,
    selectError: null as { message: string } | null,
    rpcError: null as { message: string } | null,
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
          return { data: row ?? null, error: null };
        },
      };
      return builder;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ name, ...args });
      if (state.rpcError) return { data: null, error: state.rpcError };

      const row = state.prospects.get(args.p_prospect_id as number);
      const email = (row?.email ?? "").trim().toLowerCase() || null;
      if (!email) return { data: { suppressed: false, email_present: false }, error: null };

      if (state.suppression.some((s) => s.email === email)) {
        return { data: { suppressed: false, email_present: true }, error: null };
      }
      state.suppression.push({
        email,
        channel: "email",
        reason: "unsubscribe",
        source: args.p_source,
      });
      state.events.push({
        prospect_id: args.p_prospect_id,
        event: "unsubscribed",
        detail: { via: args.p_via, user_agent: args.p_user_agent },
      });
      return { data: { suppressed: true, email_present: true }, error: null };
    },
  };

  return { state, client };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => db.client,
}));

const { GET, POST } = await import("@/app/api/unsubscribe/[token]/route");

function ctx(token: string) {
  return { params: { token } };
}

function oneClickPost(token: string, headers: Record<string, string> = {}) {
  return new Request(`https://crm.test/api/unsubscribe/${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: "List-Unsubscribe=One-Click",
  });
}

function formPost(token: string) {
  return new Request(`https://crm.test/api/unsubscribe/${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "via=link",
  });
}

function getRequest(token: string) {
  return new Request(`https://crm.test/api/unsubscribe/${token}`);
}

let token: string;

beforeEach(() => {
  process.env.UNSUBSCRIBE_SECRET = SECRET;
  db.state.prospects = new Map([[PROSPECT_ID, { id: PROSPECT_ID, email: EMAIL }]]);
  db.state.suppression = [];
  db.state.events = [];
  db.state.rpcCalls = [];
  db.state.selectError = null;
  db.state.rpcError = null;
  token = mintUnsubscribeToken(PROSPECT_ID, EMAIL, SECRET);
});

describe("POST — RFC 8058 one-click", () => {
  it("writes exactly one suppression row and one event, and does not redirect", async () => {
    const response = await POST(oneClickPost(token), ctx(token));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Unsubscribed.\n");

    expect(db.state.suppression).toHaveLength(1);
    expect(db.state.suppression[0]).toMatchObject({
      email: "pino@example.com",
      channel: "email",
      reason: "unsubscribe",
    });
    expect(db.state.suppression[0].source).toMatch(/^one-click-\d{4}-\d{2}-\d{2}$/);

    expect(db.state.events).toHaveLength(1);
    expect(db.state.events[0]).toMatchObject({
      prospect_id: PROSPECT_ID,
      event: "unsubscribed",
      detail: { via: "rfc8058" },
    });
  });

  it("accepts a bare post with no body as one-click too", async () => {
    const response = await POST(
      new Request(`https://crm.test/api/unsubscribe/${token}`, { method: "POST" }),
      ctx(token),
    );

    expect(response.status).toBe(200);
    expect(db.state.suppression).toHaveLength(1);
    expect(db.state.events[0].detail).toMatchObject({ via: "rfc8058" });
  });

  it("records the user agent on the event", async () => {
    await POST(oneClickPost(token, { "user-agent": "Mozilla/5.0 (probe)" }), ctx(token));
    expect(db.state.events[0].detail).toMatchObject({
      user_agent: "Mozilla/5.0 (probe)",
    });
  });

  it("answers 200 and writes nothing on a repeat", async () => {
    await POST(oneClickPost(token), ctx(token));
    const second = await POST(oneClickPost(token), ctx(token));

    expect(second.status).toBe(200);
    expect(await second.text()).toBe("Unsubscribed.\n");
    expect(db.state.suppression).toHaveLength(1);
    expect(db.state.events).toHaveLength(1);
  });
});

describe("POST — the human-clicked button", () => {
  it("sources the row as a link and confirms in HTML", async () => {
    const response = await POST(formPost(token), ctx(token));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await response.text()).toContain("Unsubscribed");
    expect(db.state.suppression[0].source).toMatch(/^link-\d{4}-\d{2}-\d{2}$/);
    expect(db.state.events[0].detail).toMatchObject({ via: "link" });
  });
});

describe("POST — rejected tokens", () => {
  const badTokens = (): Array<[string, string]> => [
    ["a bad MAC", mintUnsubscribeToken(PROSPECT_ID, EMAIL, "a-different-secret")],
    ["another prospect's address", mintUnsubscribeToken(PROSPECT_ID, "someone@else.com", SECRET)],
    ["an unknown prospect id", mintUnsubscribeToken(999999, EMAIL, SECRET)],
    ["a malformed token", "not-a-real-token"],
    ["an empty token", ""],
  ];

  it.each(badTokens())("404s on %s and writes nothing", async (_label, bad) => {
    const response = await POST(oneClickPost(bad), ctx(bad));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await response.text()).toBe("Not found.\n");
    expect(db.state.suppression).toHaveLength(0);
    expect(db.state.events).toHaveLength(0);
    expect(db.state.rpcCalls).toHaveLength(0);
  });

  it("gives an unknown id the same answer as a bad MAC", async () => {
    const unknown = mintUnsubscribeToken(999999, EMAIL, SECRET);
    const forged = mintUnsubscribeToken(PROSPECT_ID, EMAIL, "a-different-secret");

    const a = await POST(oneClickPost(unknown), ctx(unknown));
    const b = await POST(oneClickPost(forged), ctx(forged));

    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });
});

describe("POST — failure modes", () => {
  it("503s when UNSUBSCRIBE_SECRET is unset, rather than dropping the opt-out", async () => {
    delete process.env.UNSUBSCRIBE_SECRET;
    const response = await POST(oneClickPost(token), ctx(token));

    expect(response.status).toBe(503);
    expect(db.state.rpcCalls).toHaveLength(0);
  });

  it("500s on a database error, so the provider retries", async () => {
    db.state.rpcError = { message: "boom" };
    const response = await POST(oneClickPost(token), ctx(token));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Unsubscribe failed.\n");
  });
});

describe("GET", () => {
  it("renders one form that posts to the same URL, and writes nothing", async () => {
    const response = await GET(getRequest(token), ctx(token));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(body).toContain('<form method="post">');
    expect(body).toContain('name="via" value="link"');
    expect(body).toContain("<button type=\"submit\">Unsubscribe</button>");
    // No action attribute: the form posts to the current URL, so the token
    // never has to be re-rendered into markup.
    expect(body).not.toContain("action=");

    expect(db.state.suppression).toHaveLength(0);
    expect(db.state.events).toHaveLength(0);
    expect(db.state.rpcCalls).toHaveLength(0);
  });

  it("404s on a bad MAC", async () => {
    const bad = mintUnsubscribeToken(PROSPECT_ID, EMAIL, "a-different-secret");
    const response = await GET(getRequest(bad), ctx(bad));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found.\n");
  });
});
