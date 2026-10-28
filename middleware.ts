import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { isPfPath, isGateExempt } from "@/lib/roles";
import { handleShortLinkRequest, isShortLinkHost } from "@/lib/shortLinks";

// Personal-finance pages live on their own subdomain (same Vercel project,
// host-routed) — mirroring how crm./time. split off this repo.
const PF_HOST = "personal.withers-ventures.com";

const CRON_CATERING_SHIFTS = "/api/cron/catering-shifts";

export async function middleware(request: NextRequest, event?: NextFetchEvent) {
  const host = request.headers.get("host") ?? "";
  const { pathname } = request.nextUrl;

  // benjerryphilly.com short links (lib/shortLinks.ts). Decided on the Host
  // header alone and before anything else: that domain serves nothing but
  // redirects, so no CRM route, exemption or login is reachable through it.
  // On every other host, /cake and friends meet the login gate like any path.
  if (isShortLinkHost(host)) {
    return handleShortLinkRequest(request, event);
  }

  // One-click unsubscribe (bj-finance #440) is public by construction: the
  // recipient is not a CRM user, the token is the authorisation, and RFC 8058
  // §3.2 forbids the endpoint from redirecting at all — which is exactly what
  // the auth gate below does to an anonymous request. Returned before
  // updateSession so there is no Supabase round trip either.
  if (pathname.startsWith("/api/unsubscribe/")) {
    return NextResponse.next();
  }
  // "Yes, send me offers" (bj-finance #425) is public for the same reason:
  // the person is not a CRM user and the signed token is the authorisation.
  // The auth gate would bounce them to /login.
  if (pathname.startsWith("/offers/")) {
    return NextResponse.next();
  }
  // Open and click tracking (docs/tracking.md) is public for the same reason:
  // the pixel is fetched by a mail client or image proxy and the link by
  // whoever got the mail, none of them CRM users; the signed token is the
  // authorisation. The gate would answer the pixel with a login page and turn
  // every tracked link into a /login prompt. Returned before updateSession so
  // there is no Supabase round trip either.
  if (pathname.startsWith("/api/t/")) {
    return NextResponse.next();
  }

  // The catering-shift sweep is hit by a scheduler, which has no session, so
  // the auth gate below would 307 it to /login and nothing would ever run
  // (crm-app #35). Exact path only: every other route, including
  // /api/deals/:id/booked-shifts, stays behind the login. The route itself
  // requires CRON_SECRET and answers 503 when it is unset (lib/cronAuth.ts).
  if (pathname === CRON_CATERING_SHIFTS) {
    return NextResponse.next();
  }
  // THROWAWAY PROTOTYPE (bj-finance #811): the one-screen console renders a
  // synthetic fixture with no login in local dev only, when
  // CONSOLE_PROTO_SYNTHETIC=1. Production and previews keep the normal gate.
  if (
    process.env.NODE_ENV === "development" &&
    process.env.CONSOLE_PROTO_SYNTHETIC === "1" &&
    pathname === "/email-campaigns/console"
  ) {
    return NextResponse.next();
  }
  const isPfRoute = isPfPath(pathname);

  if (host === PF_HOST) {
    // Landing: the phone-frequent widget. Auth still applies below.
    if (pathname === "/") {
      return NextResponse.redirect(new URL("/safe", request.url));
    }
    // Keep the CRM off this host (auth/login routes stay shared, and so do
    // sign-out and the "no access" page the role gate sends an employee to;
    // bouncing those to /safe would loop them between /safe and /no-access).
    if (
      !isPfRoute &&
      pathname !== "/login" &&
      !pathname.startsWith("/auth") &&
      !isGateExempt(pathname)
    ) {
      return NextResponse.redirect(new URL("/safe", request.url));
    }
  } else if (isPfRoute && host.endsWith("withers-ventures.com")) {
    // PF pages moved off the CRM host — same path on the personal domain.
    // (localhost / preview hosts keep serving them directly, for dev.)
    return NextResponse.redirect(new URL(`https://${PF_HOST}${pathname}`));
  }

  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    // On the short-link domain every path, assets included, goes through the
    // middleware so it redirects instead of serving a CRM file.
    {
      source: "/:path*",
      has: [{ type: "host", value: "(?:www\\.)?benjerryphilly\\.com" }],
    },
  ],
};
