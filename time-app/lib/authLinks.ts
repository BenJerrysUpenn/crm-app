// Invite and password-reset links, sent by the app itself.
//
// Why not let Supabase send them: a Supabase-sent link bounces through
// Supabase's /auth/v1/verify and then redirects to the project's Site URL /
// redirect allow-list, which is shared with the CRM and easy to misconfigure
// (2026-09-01: it pointed at localhost, so invited staff landed nowhere).
// Instead we ask Supabase for the link's token (admin generateLink), build a
// link straight to THIS site's /auth/confirm, and email it via Resend. The
// confirm route verifies the token server-side and signs the person in.
//
// When RESEND_API_KEY is unset we fall back to Supabase-sent emails, which
// need Auth -> URL Configuration to allow `${origin}/auth/callback`.
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { emailConfigured, sendEmail } from "@/lib/email";

export type Delivery = "email" | "supabase";

// Absolute origin for links in emails. Prefer NEXT_PUBLIC_SITE_URL; otherwise
// trust the proxy headers Vercel sets.
export function siteOrigin(request: Request): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return env.replace(/\/+$/, "");
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    "localhost:3000";
  const proto =
    request.headers.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

type LinkType = "invite" | "magiclink" | "recovery";

// Ask Supabase for a one-time token and wrap it in a link to our confirm route.
async function actionLink(
  type: LinkType,
  email: string,
  origin: string,
  data?: Record<string, unknown>,
): Promise<{ link: string; userId: string | null } | { error: string }> {
  const admin = createAdminClient();
  const params =
    type === "recovery"
      ? { type, email }
      : { type, email, options: data ? { data } : undefined };
  const { data: d, error } = await admin.auth.admin.generateLink(
    params as Parameters<typeof admin.auth.admin.generateLink>[0],
  );
  if (error) return { error: error.message };
  const hashed = d?.properties?.hashed_token;
  if (!hashed) return { error: "Supabase returned no token" };
  const link = `${origin}/auth/confirm?token_hash=${encodeURIComponent(hashed)}&type=${type}`;
  return { link, userId: d.user?.id ?? null };
}

export async function sendInvite(args: {
  email: string;
  fullName: string | null;
  invitedBy: string | null;
  origin: string;
}): Promise<{ userId: string | null; delivery: Delivery } | { error: string }> {
  const { email, fullName, invitedBy, origin } = args;
  const data = fullName ? { full_name: fullName } : undefined;

  if (!emailConfigured()) {
    const admin = createAdminClient();
    const { data: d, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data,
      redirectTo: `${origin}/auth/callback`,
    });
    if (error) return { error: error.message };
    return { userId: d.user?.id ?? null, delivery: "supabase" };
  }

  // A brand-new person gets an invite token. Someone who already has an
  // account (re-invite, lost their password before ever setting one) gets a
  // magic-link token instead; both land on the set-password page.
  let made = await actionLink("invite", email, origin, data);
  if ("error" in made) made = await actionLink("magiclink", email, origin, data);
  if ("error" in made) return made;

  const greeting = fullName ? `Hi ${fullName.split(" ")[0]},` : "Hi,";
  const who = invitedBy ? `${invitedBy} added you` : "You've been added";
  const text = [
    greeting,
    "",
    `${who} to Withers Time, the Ben & Jerry's UPenn time clock and schedule app.`,
    "",
    "Set your password and sign in here:",
    made.link,
    "",
    "The link works once and expires after about an hour. If it has expired, ask your manager to resend the invite from the Team page.",
    "",
    `After that, sign in any time at ${origin} with this email address.`,
  ].join("\n");
  const ok = await sendEmail(email, "You're invited to Withers Time", text);
  if (!ok) return { error: "Invite email could not be sent (Resend rejected it)." };
  return { userId: made.userId, delivery: "email" };
}

// Password reset. Never reveals whether the address has an account.
export async function sendPasswordReset(args: {
  email: string;
  origin: string;
}): Promise<{ delivery: Delivery | "none" }> {
  const { email, origin } = args;

  if (!emailConfigured()) {
    const anon = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    await anon.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/auth/callback`,
    });
    return { delivery: "supabase" };
  }

  const made = await actionLink("recovery", email, origin);
  if ("error" in made) return { delivery: "none" }; // unknown address: say nothing
  const text = [
    "Hi,",
    "",
    "Someone asked to reset the Withers Time password for this email address. If that was you, choose a new password here:",
    made.link,
    "",
    "The link works once and expires after about an hour. If you didn't ask for this, ignore this email; your password stays as it is.",
  ].join("\n");
  await sendEmail(email, "Reset your Withers Time password", text);
  return { delivery: "email" };
}
