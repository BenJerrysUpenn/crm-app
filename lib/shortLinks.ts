import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

// Branded short links on benjerryphilly.com (Alina, 2026-10-10).
//
// The below-minimum catering decline email (Catering-Manager PR #14) prints
// links such as benjerryphilly.com/cake/<code>. Those must look like our domain
// on hover, so they are redirects we own: log a click, then 302 onward.
// Every other path on the domain 301s to the B&J UPenn page, which is what
// Squarespace domain forwarding does today and must keep doing after cutover.
//
// A link may carry a per-deal code: benjerryphilly.com/cake/<code>. The code
// is minted by Catering-Manager into short_link_codes (supabase/crm/010), one
// per catering deal, so a click ties back to the deal. The code never changes
// where the link goes; it only adds code and deal_id to the click row. The
// bare links keep working as before. No IP address is stored.

/** The link table. Adding a link is one line here: slug -> destination.
 *  Slugs are lowercase; a request matches case-insensitively. Destinations are
 *  sent byte for byte: the Uber Eats URL's %26 must stay encoded (decoded, the
 *  store page 404s). */
export const SHORT_LINKS: Readonly<Record<string, string>> = {
  cake: "https://order.benjerry.com/menu/upenn/products/113646650",
  "uber-eats": "https://www.ubereats.com/store/ben-%26-jerrys-upenn/bq7ih-DhToCTdYzdFGrj-Q",
};

/** Where every path that is not a slug goes, with a 301. */
export const SHORT_LINK_FALLBACK = "https://www.benjerry.com/upenn";

const SHORT_LINK_HOSTS: readonly string[] = [
  "benjerryphilly.com",
  "www.benjerryphilly.com",
];

/** Host header, lowercased, without a port. */
function bareHost(host: string | null): string {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

export function isShortLinkHost(host: string | null): boolean {
  return SHORT_LINK_HOSTS.includes(bareHost(host));
}

/** A per-deal code: 6 characters from abcdefghjkmnpqrstuvwxyz23456789 (no
 *  i, l, o, 0 or 1), stored lowercase. The same rule is a CHECK on
 *  short_link_codes.code. Anything else is never looked up. */
const SHORT_LINK_CODE = /^[a-hj-km-np-z2-9]{6}$/;

export function isShortLinkCode(code: string | null): code is string {
  return code !== null && SHORT_LINK_CODE.test(code);
}

/** The longest path tail kept in the click row's code column. */
const MAX_CODE = 64;

export type ShortLinkTarget =
  | { slug: string; code: string | null; location: string; status: 302 }
  | { slug: null; code: null; location: string; status: 301 };

/** "/cake", "/cake/" and "/CAKE" are the cake link, with no code.
 *  "/cake/<anything>" is the cake link too, and <anything> (lowercased, deeper
 *  segments included) is the code to record; whether it is a real code is
 *  decided later, and never changes the destination. Anything else, including
 *  "/" or an unknown slug with or without a code, is the fallback. */
export function resolveShortLink(pathname: string): ShortLinkTarget {
  const [first = "", ...rest] = pathname.split("/").filter(Boolean);
  const slug = first.toLowerCase();
  if (slug && Object.prototype.hasOwnProperty.call(SHORT_LINKS, slug)) {
    const tail = rest.join("/").toLowerCase().slice(0, MAX_CODE);
    return { slug, code: tail || null, location: SHORT_LINKS[slug], status: 302 };
  }
  return { slug: null, code: null, location: SHORT_LINK_FALLBACK, status: 301 };
}

// Link scanners fetch every URL in a mail before (or instead of) a person:
// Microsoft Safe Links / Defender, Google, Barracuda, Mimecast, Proofpoint and
// friends, plus chat-app unfurlers and scripted clients. They are logged but
// flagged, so counts can leave them out. A missing user agent counts as a bot.
const BOT_USER_AGENT =
  /\bbot\b|bot\/|bot-|crawl|spider|slurp|scan|preview|safelinks|safe-links|microsoft office|ms-office|msoffice|office protocol discovery|existence discovery|outlook-ios-linkpreview|google-safety|google-inspectiontool|googleother|appengine-google|feedfetcher|barracuda|mimecast|proofpoint|urldefense|symantec|messagelabs|trend ?micro|sophos|forcepoint|ironport|cisco|zscaler|fireeye|trellix|checkpoint|check point|mailguard|headlesschrome|phantomjs|puppeteer|playwright|selenium|facebookexternalhit|whatsapp|skypeuripreview|slack|discord|telegram|linkedin|curl\/|wget|python|go-http-client|okhttp|java\/|libwww|httpclient|axios|node-fetch|undici|postman|insomnia/i;

export function isProbableBot(method: string, userAgent: string | null): boolean {
  if (method.toUpperCase() === "HEAD") return true;
  const ua = (userAgent ?? "").trim();
  if (!ua) return true;
  return BOT_USER_AGENT.test(ua);
}

const MAX_HEADER = 500;

function clip(value: string | null): string | null {
  if (!value) return null;
  return value.length > MAX_HEADER ? value.slice(0, MAX_HEADER) : value;
}

/** What the request said: which link, which code (if any), what fetched it. */
type ShortLinkVisit = {
  slug: string;
  code: string | null;
  user_agent: string | null;
  referer: string | null;
  is_probable_bot: boolean;
};

/** One short_link_clicks row: the visit plus the deal its code belongs to.
 *  deal_id is null for a bare link, a malformed code, an unknown code, or a
 *  lookup that failed. */
type ShortLinkClick = ShortLinkVisit & { deal_id: number | null };

type Supabase = { base: string; key: string };

function serviceHeaders({ key }: Supabase): Record<string, string> {
  return { apikey: key, authorization: `Bearer ${key}` };
}

/** The deal a code was minted for, or null. A malformed code is never sent to
 *  the database. Never throws: a failed lookup is logged and the click is
 *  recorded without a deal. */
async function lookupDealId(db: Supabase, slug: string, code: string | null): Promise<number | null> {
  if (!isShortLinkCode(code)) return null;
  try {
    // code is [a-z2-9]{6} here, so it is safe in the query string as is.
    const res = await fetch(
      `${db.base}/rest/v1/short_link_codes?select=deal_id&code=eq.${code}&limit=1`,
      { headers: { ...serviceHeaders(db), accept: "application/json" } },
    );
    if (!res.ok) {
      console.error(
        `short link code not resolved (${slug}/${code}): HTTP ${res.status} ${await res.text().catch(() => "")}`,
      );
      return null;
    }
    const rows: unknown = await res.json();
    const dealId = Array.isArray(rows) ? (rows[0] as { deal_id?: unknown } | undefined)?.deal_id : undefined;
    return typeof dealId === "number" ? dealId : null;
  } catch (err) {
    console.error(`short link code not resolved (${slug}/${code}):`, err);
    return null;
  }
}

/** Resolve the visit's code to a deal (short_link_codes), then insert one row
 *  into short_link_clicks (supabase/crm/010), both with the service role.
 *  Never throws: a failed lookup records the click without a deal, and a
 *  failed insert is logged and swallowed, because the redirect must happen
 *  regardless. It runs inside event.waitUntil, after the redirect is built.
 *
 *  Plain PostgREST calls rather than lib/supabase/admin.ts, because they need
 *  the service role key itself: admin.ts falls back to the anon key, which RLS
 *  refuses here, so an unset key is reported as such instead of as a 401. */
async function recordShortLinkClick(visit: ShortLinkVisit): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(`short link click not logged (${visit.slug}): Supabase URL or service role key unset`);
    return;
  }
  const db: Supabase = { base: url.replace(/\/+$/, ""), key };
  try {
    const click: ShortLinkClick = { ...visit, deal_id: await lookupDealId(db, visit.slug, visit.code) };
    const res = await fetch(`${db.base}/rest/v1/short_link_clicks`, {
      method: "POST",
      headers: {
        ...serviceHeaders(db),
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(click),
    });
    if (!res.ok) {
      console.error(
        `short link click not logged (${visit.slug}): HTTP ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
  } catch (err) {
    console.error(`short link click not logged (${visit.slug}):`, err);
  }
}

/** The whole response for a request on a short-link host. The code lookup and
 *  the click insert are handed to event.waitUntil, so they never delay the
 *  redirect; the redirect is built before either starts and does not depend
 *  on the code, so a failure cannot change it. */
export function handleShortLinkRequest(
  request: NextRequest,
  // Next always passes the event in production; it is optional only so a
  // direct call (a test) without one still redirects.
  event?: Pick<NextFetchEvent, "waitUntil">,
): NextResponse {
  const target = resolveShortLink(request.nextUrl.pathname);

  // Location is set by hand rather than through NextResponse.redirect so the
  // destination goes out exactly as written in SHORT_LINKS.
  const response = new NextResponse(null, {
    status: target.status,
    headers: {
      location: target.location,
      // A 302 must not be cached, or a repeat click never reaches us to count.
      "cache-control": target.status === 302 ? "no-store" : "public, max-age=3600",
      "x-robots-tag": "noindex, nofollow",
    },
  });

  if (target.slug) {
    const userAgent = request.headers.get("user-agent");
    const visit: ShortLinkVisit = {
      slug: target.slug,
      code: target.code,
      user_agent: clip(userAgent),
      referer: clip(request.headers.get("referer")),
      is_probable_bot: isProbableBot(request.method, userAgent),
    };
    try {
      const logged = recordShortLinkClick(visit);
      if (event) event.waitUntil(logged);
    } catch (err) {
      console.error(`short link click not logged (${visit.slug}):`, err);
    }
  }

  return response;
}
