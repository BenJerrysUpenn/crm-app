import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options?: CookieOptions }[],
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  // /api/cron/* is machine-facing: a scheduler calls it with no Supabase session,
  // so it has to skip both the login redirect and the manager gate below. Those
  // routes are responsible for their own auth and must require CRON_SECRET.
  const isPublic =
    path === "/login" ||
    path.startsWith("/auth") ||
    path.startsWith("/_next") ||
    path.startsWith("/api/cron") ||
    path === "/favicon.ico";

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  // Manager-only gate. This Supabase project is shared with the time-clock app,
  // whose employees must NOT be able to reach the CRM. Only profiles with
  // role = 'manager' get in. Non-managers are bounced to /no-access (but can
  // still log out). The deals RLS policy enforces the same rule at the DB level.
  if (
    user &&
    !isPublic &&
    path !== "/no-access" &&
    !path.startsWith("/api/logout")
  ) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (profile?.role !== "manager") {
      const url = request.nextUrl.clone();
      url.pathname = "/no-access";
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}
