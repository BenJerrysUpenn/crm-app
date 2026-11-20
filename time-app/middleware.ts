import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { routeForHost } from "@/lib/hosts";
import { previewEnabled } from "@/lib/localPreview";

/**
 * The Labor Hours Planning local preview (bj-finance #742) and the door its
 * inputs editor saves through have no sign-in: they run only on a
 * developer's machine. Both of previewEnabled's conditions are needed, and a production build is
 * always NODE_ENV=production, so there it never applies.
 */
function isLocalPreview(pathname: string): boolean {
  return previewEnabled() && (pathname === "/dev/labor-hours-planning" || pathname === "/api/dev/labor-planning-inputs");
}

export async function middleware(request: NextRequest) {
  if (isLocalPreview(request.nextUrl.pathname)) return NextResponse.next();

  // Which site is this? finance.withers-ventures.com serves only the finance
  // pages, sign-in and the APIs they call; time.withers-ventures.com sends the
  // finance pages there. Decided before auth so a redirect costs no session
  // lookup. See lib/hosts.ts.
  const route = routeForHost(request.headers.get("host"), request.nextUrl.pathname, request.nextUrl.search);
  if (route.kind === "redirect")
    return NextResponse.redirect(new URL(route.location, request.url), route.status);
  if (route.kind === "not_found")
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
