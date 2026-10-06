import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Personal-finance pages live on their own subdomain (same Vercel project,
// host-routed) — mirroring how crm./time. split off this repo.
const PF_HOST = "personal.withers-ventures.com";
const PF_ROUTES = ["/money", "/dial", "/safe"];

const CRON_CATERING_SHIFTS = "/api/cron/catering-shifts";

export async function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const { pathname } = request.nextUrl;

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

  // The catering-shift sweep is hit by a scheduler, which has no session, so
  // the auth gate below would 307 it to /login and nothing would ever run
  // (crm-app #35). Exact path only: every other route, including
  // /api/deals/:id/booked-shifts, stays behind the login. The route itself
  // requires CRON_SECRET and answers 503 when it is unset (lib/cronAuth.ts).
  if (pathname === CRON_CATERING_SHIFTS) {
    return NextResponse.next();
  }
  const isPfRoute = PF_ROUTES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );

  if (host === PF_HOST) {
    // Landing: the phone-frequent widget. Auth still applies below.
    if (pathname === "/") {
      return NextResponse.redirect(new URL("/safe", request.url));
    }
    // Keep the CRM off this host (auth/login routes stay shared).
    if (!isPfRoute && pathname !== "/login" && !pathname.startsWith("/auth")) {
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
  ],
};
