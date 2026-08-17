import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Personal-finance pages live on their own subdomain (same Vercel project,
// host-routed) — mirroring how crm./time. split off this repo.
const PF_HOST = "personal.withers-ventures.com";
const PF_ROUTES = ["/money", "/dial", "/safe"];

export async function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const { pathname } = request.nextUrl;
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
