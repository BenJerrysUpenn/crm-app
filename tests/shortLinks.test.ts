// benjerryphilly.com short links (lib/shortLinks.ts, middleware.ts).
//
// What is pinned here:
//   * /cake and /uber-eats log a click and 302 to their destinations, the
//     Uber Eats %26 byte for byte;
//   * /cake/<code> and /uber-eats/<code> go to the same place, and the click
//     row carries the code and the deal it was minted for; a malformed code
//     is never looked up, an unknown one or a failed lookup leaves deal_id
//     null, and none of it delays or changes the redirect;
//   * every other path on the domain 301s to benjerry.com/upenn;
//   * the CRM host is untouched: /cake there meets the login gate;
//   * link scanners and HEAD requests are flagged, people are not;
//   * a failed insert still redirects.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const gate = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: async (request: NextRequest) => {
    gate.calls.push(request.nextUrl.pathname);
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  },
}));

// The code lookup is one PostgREST GET on short_link_codes and the click
// insert one POST on short_link_clicks. Stand in for fetch with a tiny
// database that answers from `codes`, records what arrived, or fails the way
// it is told to.
const db = {
  rows: [] as Array<{ url: string; headers: Record<string, string>; row: Record<string, unknown> }>,
  status: 201,
  throws: false,
  codes: {} as Record<string, number>,
  lookups: [] as Array<{ url: string; headers: Record<string, string> }>,
  lookupStatus: 200,
  lookupThrows: false,
  /** When set, the lookup waits on this before answering. */
  lookupGate: null as Promise<void> | null,
};
vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
  if (url.includes("/rest/v1/short_link_codes")) {
    db.lookups.push({ url, headers: init.headers as Record<string, string> });
    if (db.lookupGate) await db.lookupGate;
    if (db.lookupThrows) throw new TypeError("fetch failed");
    if (db.lookupStatus >= 300) {
      return new Response('{"message":"upstream error"}', { status: db.lookupStatus });
    }
    const code = new URL(url).searchParams.get("code")!.replace(/^eq\./, "");
    const dealId = db.codes[code];
    return Response.json(dealId === undefined ? [] : [{ deal_id: dealId }]);
  }
  if (db.throws) throw new TypeError("fetch failed");
  if (db.status >= 300) return new Response('{"message":"permission denied"}', { status: db.status });
  db.rows.push({
    url,
    headers: init.headers as Record<string, string>,
    row: JSON.parse(init.body as string),
  });
  return new Response(null, { status: db.status });
});

const { middleware } = await import("@/middleware");
const { isProbableBot, isShortLinkCode, resolveShortLink, SHORT_LINKS, SHORT_LINK_FALLBACK } =
  await import("@/lib/shortLinks");

const CAKE = "https://order.benjerry.com/menu/upenn/products/113646650";
const UBER = "https://www.ubereats.com/store/ben-%26-jerrys-upenn/bq7ih-DhToCTdYzdFGrj-Q";
const UPENN = "https://www.benjerry.com/upenn";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function request(
  path: string,
  {
    host = "benjerryphilly.com",
    method = "GET",
    headers = { "user-agent": CHROME } as Record<string, string>,
  } = {},
) {
  return new NextRequest(`https://${host}${path}`, {
    method,
    headers: { host, ...headers },
  });
}

/** Runs the middleware with a fetch event whose waitUntil promises are kept,
 *  then lets them settle, as the platform would after the response is sent. */
async function run(req: NextRequest) {
  const pending: Promise<unknown>[] = [];
  const event = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const response = await middleware(req, event as never);
  await Promise.all(pending);
  return { response, pending };
}

beforeEach(() => {
  gate.calls = [];
  db.rows = [];
  db.status = 201;
  db.throws = false;
  db.codes = { k7m2qp: 4242, abc234: 77 };
  db.lookups = [];
  db.lookupStatus = 200;
  db.lookupThrows = false;
  db.lookupGate = null;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the link table", () => {
  it("holds the two links and the fallback as given", () => {
    expect(SHORT_LINKS).toEqual({ cake: CAKE, "uber-eats": UBER });
    expect(SHORT_LINK_FALLBACK).toBe(UPENN);
  });

  it.each([
    ["/cake", "cake"],
    ["/cake/", "cake"],
    ["/CAKE", "cake"],
    ["/uber-eats", "uber-eats"],
    ["/Uber-Eats/", "uber-eats"],
  ])("resolves %s to the %s link, with no code", (path, slug) => {
    const target = resolveShortLink(path);
    expect(target.slug).toBe(slug);
    expect(target.code).toBeNull();
    expect(target.status).toBe(302);
  });

  it.each([
    ["/cake/k7m2qp", "cake", "k7m2qp"],
    ["/cake/k7m2qp/", "cake", "k7m2qp"],
    ["/CAKE/K7M2QP", "cake", "k7m2qp"],
    ["/uber-eats/abc234", "uber-eats", "abc234"],
    ["/cake/extra", "cake", "extra"],
    ["/cake/abc123/extra", "cake", "abc123/extra"],
  ])("resolves %s to the %s link with code %j", (path, slug, code) => {
    const target = resolveShortLink(path);
    expect(target).toEqual({ slug, code, location: SHORT_LINKS[slug], status: 302 });
  });

  it("keeps at most 64 characters of the code", () => {
    expect(resolveShortLink(`/cake/${"a".repeat(200)}`).code).toBe("a".repeat(64));
  });

  it.each([
    "/",
    "",
    "/cakes",
    "/uber",
    "/constructor",
    "/__proto__",
    "/cakes/k7m2qp",
    "/menu/k7m2qp",
    "/constructor/k7m2qp",
  ])("sends %j to the fallback", (path) => {
    expect(resolveShortLink(path)).toEqual({ slug: null, code: null, location: UPENN, status: 301 });
  });

  it.each(["k7m2qp", "abc234", "zzzzzz", "222222"])("accepts %s as a code", (code) => {
    expect(isShortLinkCode(code)).toBe(true);
  });

  it.each([
    ["too short", "k7m2q"],
    ["too long", "k7m2qpp"],
    ["uppercase (lowercased before the check)", "K7M2QP"],
    ["an i", "k7m2qi"],
    ["an l", "k7m2ql"],
    ["an o", "k7m2qo"],
    ["a 0", "k7m2q0"],
    ["a 1", "k7m2q1"],
    ["punctuation", "k7m-qp"],
    ["a nested path", "k7m2qp/x"],
    ["empty", ""],
  ])("rejects a code with %s", (_label, code) => {
    expect(isShortLinkCode(code)).toBe(false);
  });

  it("rejects no code", () => {
    expect(isShortLinkCode(null)).toBe(false);
  });
});

describe("slug routing on benjerryphilly.com", () => {
  it.each([
    ["benjerryphilly.com", "/cake", CAKE, "cake"],
    ["www.benjerryphilly.com", "/cake", CAKE, "cake"],
    ["benjerryphilly.com", "/uber-eats", UBER, "uber-eats"],
    ["WWW.BenJerryPhilly.com", "/uber-eats", UBER, "uber-eats"],
  ])("%s%s logs a click and 302s", async (host, path, location, slug) => {
    const { response } = await run(request(path, { host }));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(location);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(gate.calls).toEqual([]);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].url).toBe("https://project.supabase.co/rest/v1/short_link_clicks");
    expect(db.rows[0].headers.authorization).toBe("Bearer service-role-key");
    expect(db.rows[0].row).toEqual({
      slug,
      code: null,
      deal_id: null,
      user_agent: CHROME,
      referer: null,
      is_probable_bot: false,
    });
    expect(db.lookups).toEqual([]);
  });

  it("keeps the Uber Eats %26 encoded", async () => {
    const { response } = await run(request("/uber-eats"));
    expect(response.headers.get("location")).toContain("ben-%26-jerrys-upenn");
    expect(response.headers.get("location")).not.toContain("&");
  });

  it("records the referer, and stores no IP", async () => {
    await run(
      request("/cake", {
        headers: {
          "user-agent": IPHONE,
          referer: "https://mail.google.com/",
          "x-forwarded-for": "203.0.113.7",
          "x-real-ip": "203.0.113.7",
        },
      }),
    );

    expect(db.rows).toHaveLength(1);
    const row = db.rows[0].row;
    expect(row.referer).toBe("https://mail.google.com/");
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
  });

  it("hands the insert to waitUntil rather than awaiting it before the redirect", async () => {
    const { pending } = await run(request("/cake"));
    expect(pending).toHaveLength(1);
  });
});

describe("per-deal codes", () => {
  it.each([
    ["benjerryphilly.com", "/cake/k7m2qp", CAKE, "cake", "k7m2qp", 4242],
    ["www.benjerryphilly.com", "/cake/abc234", CAKE, "cake", "abc234", 77],
    ["benjerryphilly.com", "/uber-eats/k7m2qp", UBER, "uber-eats", "k7m2qp", 4242],
    ["benjerryphilly.com", "/uber-eats/abc234/", UBER, "uber-eats", "abc234", 77],
  ])("%s%s 302s like the bare slug and logs the code with its deal", async (host, path, location, slug, code, dealId) => {
    const { response } = await run(request(path, { host }));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(location);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(gate.calls).toEqual([]);
    expect(db.lookups).toHaveLength(1);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].row).toEqual({
      slug,
      code,
      deal_id: dealId,
      user_agent: CHROME,
      referer: null,
      is_probable_bot: false,
    });
  });

  it("looks the code up with the service role, by exact code", async () => {
    await run(request("/cake/k7m2qp"));

    expect(db.lookups).toHaveLength(1);
    const lookup = new URL(db.lookups[0].url);
    expect(lookup.origin + lookup.pathname).toBe("https://project.supabase.co/rest/v1/short_link_codes");
    expect(lookup.searchParams.get("code")).toBe("eq.k7m2qp");
    expect(lookup.searchParams.get("select")).toBe("deal_id");
    expect(db.lookups[0].headers.authorization).toBe("Bearer service-role-key");
  });

  it("matches an uppercase code, and stores it lowercase", async () => {
    const { response } = await run(request("/CAKE/K7M2QP"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(CAKE);
    expect(new URL(db.lookups[0].url).searchParams.get("code")).toBe("eq.k7m2qp");
    expect(db.rows[0].row).toMatchObject({ slug: "cake", code: "k7m2qp", deal_id: 4242 });
  });

  it.each(["k7m2q", "k7m2qpp", "k7m2q1", "k7m2q0", "k7m2qi", "k7m2ql", "k7m2qo", "k7m-qp", "%27or1"])(
    "redirects a malformed code %j without looking it up, deal_id null",
    async (code) => {
      const { response } = await run(request(`/cake/${code}`));

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(CAKE);
      expect(db.lookups).toEqual([]);
      expect(db.rows).toHaveLength(1);
      expect(db.rows[0].row).toMatchObject({ slug: "cake", code: code.toLowerCase(), deal_id: null });
    },
  );

  it("logs an unknown code with deal_id null", async () => {
    const { response } = await run(request("/uber-eats/zzzzzz"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(UBER);
    expect(db.lookups).toHaveLength(1);
    expect(db.rows[0].row).toMatchObject({ slug: "uber-eats", code: "zzzzzz", deal_id: null });
  });

  it("treats a deeper path as an unknown code on that slug", async () => {
    const { response } = await run(request("/cake/abc234/extra"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(CAKE);
    expect(db.lookups).toEqual([]);
    expect(db.rows[0].row).toMatchObject({ slug: "cake", code: "abc234/extra", deal_id: null });
  });

  it.each(["/cakes/k7m2qp", "/menu/k7m2qp", "/k7m2qp"])(
    "301s an unknown slug with a code (%s) to benjerry.com/upenn and logs nothing",
    async (path) => {
      const { response, pending } = await run(request(path));

      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(UPENN);
      expect(pending).toEqual([]);
      expect(db.lookups).toEqual([]);
      expect(db.rows).toEqual([]);
    },
  );

  it("still redirects, and logs without a deal, when the lookup answers with an error", async () => {
    db.lookupStatus = 500;
    const { response } = await run(request("/cake/k7m2qp"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(CAKE);
    expect(db.rows[0].row).toMatchObject({ code: "k7m2qp", deal_id: null });
    expect(console.error).toHaveBeenCalled();
  });

  it("still redirects, and logs without a deal, when the lookup throws", async () => {
    db.lookupThrows = true;
    const { response } = await run(request("/uber-eats/k7m2qp"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(UBER);
    expect(db.rows[0].row).toMatchObject({ code: "k7m2qp", deal_id: null });
    expect(console.error).toHaveBeenCalled();
  });

  it("still redirects when both the lookup and the insert fail", async () => {
    db.lookupThrows = true;
    db.throws = true;
    const { response } = await run(request("/cake/k7m2qp"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(CAKE);
  });

  it("returns the redirect before the lookup has answered", async () => {
    let open!: () => void;
    db.lookupGate = new Promise<void>((resolve) => (open = resolve));
    const pending: Promise<unknown>[] = [];
    const event = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };

    const response = await middleware(request("/cake/k7m2qp"), event as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(CAKE);
    expect(pending).toHaveLength(1);
    expect(db.rows).toEqual([]);

    open();
    await Promise.all(pending);
    expect(db.rows[0].row).toMatchObject({ code: "k7m2qp", deal_id: 4242 });
  });

  it("neither looks up nor inserts when the service role key is unset", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { response } = await run(request("/cake/k7m2qp"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(CAKE);
    expect(db.lookups).toEqual([]);
    expect(db.rows).toEqual([]);
  });

  it("attributes a scanner's click to the deal, flagged", async () => {
    await run(request("/cake/k7m2qp", { headers: { "user-agent": "Barracuda Sentinel (EE)" } }));
    expect(db.rows[0].row).toMatchObject({ deal_id: 4242, is_probable_bot: true });
  });
});

describe("every other path on the domain", () => {
  it.each([
    ["benjerryphilly.com", "/"],
    ["www.benjerryphilly.com", "/"],
    ["benjerryphilly.com", "/menu"],
    ["benjerryphilly.com", "/cakes"],
    ["benjerryphilly.com", "/login"],
    ["benjerryphilly.com", "/api/unsubscribe/some-token"],
    ["benjerryphilly.com", "/offers/some-token"],
    ["benjerryphilly.com", "/api/cron/catering-shifts"],
    ["www.benjerryphilly.com", "/deals/123"],
  ])("%s%s 301s to benjerry.com/upenn and logs nothing", async (host, path) => {
    const { response, pending } = await run(request(path, { host }));

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(UPENN);
    expect(gate.calls).toEqual([]);
    expect(pending).toEqual([]);
    expect(db.rows).toEqual([]);
  });
});

describe("the CRM host is unaffected", () => {
  it.each(["/cake", "/uber-eats", "/", "/cake/k7m2qp", "/uber-eats/abc234"])(
    "gates %s on crm.withers-ventures.com",
    async (path) => {
      const { response, pending } = await run(request(path, { host: "crm.withers-ventures.com" }));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
      expect(gate.calls).toEqual([path]);
      expect(pending).toEqual([]);
      expect(db.lookups).toEqual([]);
      expect(db.rows).toEqual([]);
    },
  );

  it.each(["benjerryphilly.com.evil.example", "notbenjerryphilly.com", "cake.benjerryphilly.com"])(
    "does not treat %s as the short-link host",
    async (host) => {
      const { response } = await run(request("/cake", { host }));
      expect(response.status).toBe(307);
      expect(db.rows).toEqual([]);
    },
  );
});

describe("bot flagging", () => {
  it.each([
    ["Microsoft Safe Links / Outlook prefetch", "Mozilla/4.0 (compatible; ms-office; MSOffice 16)"],
    ["Office existence discovery", "Microsoft Office Existence Discovery"],
    ["Googlebot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
    ["Google safety", "Google-Safety"],
    ["Barracuda", "Barracuda Sentinel (EE)"],
    ["Mimecast", "Mimecast URL Protect"],
    ["Proofpoint", "Proofpoint URL Defense"],
    ["Bing preview", "Mozilla/5.0 (Windows NT 10.0) BingPreview/1.0b"],
    ["a crawler", "SomeCrawler/1.0"],
    ["Slack unfurl", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"],
    ["curl", "curl/8.4.0"],
    ["python", "python-requests/2.31"],
    ["headless Chrome", "Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36"],
  ])("flags %s", (_label, ua) => {
    expect(isProbableBot("GET", ua)).toBe(true);
  });

  it("flags a missing or blank user agent", () => {
    expect(isProbableBot("GET", null)).toBe(true);
    expect(isProbableBot("GET", "   ")).toBe(true);
  });

  it("flags HEAD whatever the user agent", () => {
    expect(isProbableBot("HEAD", CHROME)).toBe(true);
  });

  it.each([
    ["desktop Chrome", CHROME],
    ["iPhone Safari", IPHONE],
    ["an Android phone whose model ends in 'bot'", "Mozilla/5.0 (Linux; Android 13; Cubot X30) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"],
  ])("does not flag %s", (_label, ua) => {
    expect(isProbableBot("GET", ua)).toBe(false);
  });

  it("logs a scanner's click flagged, and still redirects it", async () => {
    const { response } = await run(
      request("/cake", { headers: { "user-agent": "Barracuda Sentinel (EE)" } }),
    );
    expect(response.status).toBe(302);
    expect(db.rows[0].row.is_probable_bot).toBe(true);
  });

  it("logs a HEAD request flagged", async () => {
    const { response } = await run(request("/uber-eats", { method: "HEAD" }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(UBER);
    expect(db.rows[0].row.is_probable_bot).toBe(true);
  });
});

describe("a failed insert still redirects", () => {
  it("when Supabase answers with an error", async () => {
    db.status = 401;
    const { response } = await run(request("/cake"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(CAKE);
    expect(db.rows).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it("when the insert throws", async () => {
    db.throws = true;
    const { response } = await run(request("/uber-eats"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(UBER);
  });

  it("when the service role key is unset, without calling Supabase", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { response } = await run(request("/cake"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(CAKE);
    expect(db.rows).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it("when there is no fetch event to wait on", async () => {
    const response = await middleware(request("/cake"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(CAKE);
  });
});
