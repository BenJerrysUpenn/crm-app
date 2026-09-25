import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import { sendInvite, siteOrigin } from "@/lib/authLinks";
import { usableName, validateFullName } from "@/lib/profileName";
import { NextResponse } from "next/server";

// POST /api/profiles
//
// Manager-only. Creates a new team member by inviting them to sign up via
// their email address. The app emails the invite link itself via Resend and
// the link lands on /auth/confirm (falls back to a Supabase-sent invite when
// RESEND_API_KEY is unset).
//
// The auth user is created right here, by generateLink / inviteUserByEmail
// inside sendInvite, not when they first sign in. Creating it fires the
// `handle_new_user` trigger on auth.users, which inserts the profiles row with
// the name from the invite metadata (migration_21: never the email). We then
// upsert the manager's fields over that row ourselves, so the name is set even
// for a re-invite, where no new auth user is created and the trigger doesn't
// fire.
//
// Body:
//   { email: string, full_name: string, role?: 'employee'|'manager',
//     phone?: string, hourly_rate?: number }
// full_name is required: trimmed, non-empty, and not an email address.
//
// Per Alina 2026-08-27: "Add a way to add new employees on the team page."
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  let body: {
    email?: string;
    full_name?: string;
    role?: "employee" | "manager";
    phone?: string;
    hourly_rate?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@"))
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });

  const name = validateFullName(body.full_name);
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
  const full_name = name.name;

  const role: "employee" | "manager" =
    body.role === "manager" ? "manager" : "employee";
  const phone = (body.phone || "").trim() || null;
  const hourly_rate =
    typeof body.hourly_rate === "number" && !isNaN(body.hourly_rate)
      ? body.hourly_rate
      : null;

  const admin = createAdminClient();

  // Create the auth user (new invites) and email the sign-in link.
  const invite = await sendInvite({
    email,
    fullName: full_name,
    invitedBy: usableName(me.full_name),
    origin: siteOrigin(request),
  });
  if ("error" in invite)
    return NextResponse.json({ error: invite.error }, { status: 400 });

  // A re-invite goes out as a magic link, which doesn't always carry the
  // user back, so look the existing account up by email in that case.
  let userId = invite.userId;
  if (!userId) {
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const existing = (list?.users ?? []).find(
      (u) => (u.email ?? "").toLowerCase() === email,
    );
    userId = existing?.id ?? null;
  }
  if (!userId)
    return NextResponse.json({ error: "No user id returned" }, { status: 500 });

  // Upsert the profile fields, always including the name. The trigger has
  // normally inserted the row already; this covers the case where it
  // hasn't, and overwrites whatever name the row had (a re-invited account
  // may predate migration_21 and still hold its email). Tried on the admin
  // (service-role) client below first so the write doesn't depend on RLS;
  // `supabase` here is only the RLS-bound fallback used if that upsert
  // errors.
  const supabase = createClient();
  const patch: Record<string, unknown> = {
    id: userId,
    full_name,
    role,
    active: true,
  };
  if (phone !== null) patch.phone = phone;
  if (hourly_rate !== null) patch.hourly_rate = hourly_rate;

  // Try admin-client upsert first (bypasses RLS); fall back to
  // server client on any failure.
  let profErr: { message: string } | null = null;
  const { error: adminUpsertErr } = await admin
    .from("profiles")
    .upsert(patch, { onConflict: "id" });
  if (adminUpsertErr) {
    const { error: e } = await supabase
      .from("profiles")
      .upsert(patch, { onConflict: "id" });
    profErr = e;
  }
  if (profErr)
    return NextResponse.json({ error: profErr.message }, { status: 400 });

  return NextResponse.json({
    ok: true,
    user_id: userId,
    email,
    delivery: invite.delivery,
  });
}
