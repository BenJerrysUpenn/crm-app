// benjerryphilly.com short links (lib/shortLinks.ts, middleware.ts).
//
// What is pinned here:
//   * /cake and /uber-eats log a click and 302 to their destinations, the
//     Uber Eats %26 byte for byte;
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

// The click insert is one PostgREST POST. Stand in for fetch with a tiny
// table that records what arrived, or fails the way it is told to.
const db = {
  rows: [] as Array<{ url: string; headers: Record<string, string>; row: Record<string, unknown> }>,
  status: 201,
  throws: false,
};
vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
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
const { isProbableBot, resolveShortLink, SHORT_LINKS, SHORT_LINK_FALLBACK } = await import(
  "@/lib/shortLinks"
);

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
  ])("resolves %s to the %s link", (path, slug) => {
    const target = resolveShortLink(path);
    expect(target.slug).toBe(slug);
    expect(target.status).toBe(302);
  });

  it.each(["/", "", "/cakes", "/cake/extra", "/uber", "/constructor", "/__proto__"])(
    "sends %j to the fallback",
    (path) => {
      expect(resolveShortLink(path)).toEqual({ slug: null, location: UPENN, status: 301 });
    },
  );
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
      user_agent: CHROME,
      referer: null,
      is_probable_bot: false,
    });
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
  it.each(["/cake", "/uber-eats", "/"])("gates %s on crm.withers-ventures.com", async (path) => {
    const { response, pending } = await run(request(path, { host: "crm.withers-ventures.com" }));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(gate.calls).toEqual([path]);
    expect(pending).toEqual([]);
    expect(db.rows).toEqual([]);
  });

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
