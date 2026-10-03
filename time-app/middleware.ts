import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { routeForHost } from "@/lib/hosts";

export async function middleware(request: NextRequest) {
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
