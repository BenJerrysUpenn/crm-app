import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

// Branded short links on benjerryphilly.com (Alina, 2026-10-10).
//
// The below-minimum catering decline email (Catering-Manager PR #14) prints
// bare links such as benjerryphilly.com/cake. Those must look like our domain
// on hover, so they are redirects we own: log a click, then 302 onward.
// Every other path on the domain 301s to the B&J UPenn page, which is what
// Squarespace domain forwarding does today and must keep doing after cutover.
//
// The links are bare by design: no per-recipient token, so counts are per
// link, not per person. No IP address is stored.

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

export const SHORT_LINK_HOSTS: readonly string[] = [
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

export type ShortLinkTarget =
  | { slug: string; location: string; status: 302 }
  | { slug: null; location: string; status: 301 };

/** "/cake", "/cake/" and "/CAKE" are the cake link. Anything else, including
 *  "/", a nested path or an unknown slug, is the fallback. */
export function resolveShortLink(pathname: string): ShortLinkTarget {
  const slug = pathname.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
  if (slug && Object.prototype.hasOwnProperty.call(SHORT_LINKS, slug)) {
    return { slug, location: SHORT_LINKS[slug], status: 302 };
  }
  return { slug: null, location: SHORT_LINK_FALLBACK, status: 301 };
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

export type ShortLinkClick = {
  slug: string;
  user_agent: string | null;
  referer: string | null;
  is_probable_bot: boolean;
};

/** Insert one row into short_link_clicks (supabase/crm/010) with the service
 *  role. Never throws: a failed insert is logged and swallowed, because the
 *  redirect must happen regardless.
 *
 *  A plain PostgREST call rather than lib/supabase/admin.ts, because it needs
 *  the service role key itself: admin.ts falls back to the anon key, which RLS
 *  refuses here, so an unset key is reported as such instead of as a 401. */
export async function recordShortLinkClick(click: ShortLinkClick): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(`short link click not logged (${click.slug}): Supabase URL or service role key unset`);
    return;
  }
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/short_link_clicks`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(click),
    });
    if (!res.ok) {
      console.error(
        `short link click not logged (${click.slug}): HTTP ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
  } catch (err) {
    console.error(`short link click not logged (${click.slug}):`, err);
  }
}

/** The whole response for a request on a short-link host. The click insert is
 *  handed to event.waitUntil, so it never delays the redirect; the redirect is
 *  built before the insert starts, so a failure cannot change it. */
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
    const click: ShortLinkClick = {
      slug: target.slug,
      user_agent: clip(userAgent),
      referer: clip(request.headers.get("referer")),
      is_probable_bot: isProbableBot(request.method, userAgent),
    };
    try {
      const logged = recordShortLinkClick(click);
      if (event) event.waitUntil(logged);
    } catch (err) {
      console.error(`short link click not logged (${click.slug}):`, err);
    }
  }

  return response;
}
