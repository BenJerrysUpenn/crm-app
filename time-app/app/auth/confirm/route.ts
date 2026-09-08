import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// GET /auth/confirm?token_hash=...&type=invite|magiclink|recovery&next=/path
//
// Target of the links this app emails (see lib/authLinks.ts). Verifies the
// one-time token server-side, which writes the session cookies, then sends
// the person to the set-password page. Also works for links produced by
// Supabase email templates that use {{ .TokenHash }}.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token_hash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(url.searchParams.get("next"));

  const fail = new URL("/login?error=link", url.origin);
  if (!token_hash || !type) return NextResponse.redirect(fail);

  const supabase = createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash });
  if (error) return NextResponse.redirect(fail);

  return NextResponse.redirect(new URL(next, url.origin));
}

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/auth/set-password";
  return raw;
}
