import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

// POST /api/profiles
//
// Manager-only. Creates a new team member by inviting them to sign up via
// their email address. The invite email lands from Supabase Auth; when they
// set a password and log in for the first time, the `handle_new_user`
// trigger on the auth.users table creates the corresponding profiles row.
//
// Body:
//   { email: string, full_name?: string, role?: 'employee'|'manager',
//     phone?: string, hourly_rate?: number }
//
// If the auth user already exists (someone re-invited), we still upsert
// their profile fields so the manager's input isn't lost.
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

  const full_name = (body.full_name || "").trim() || null;
  const role: "employee" | "manager" =
    body.role === "manager" ? "manager" : "employee";
  const phone = (body.phone || "").trim() || null;
  const hourly_rate =
    typeof body.hourly_rate === "number" && !isNaN(body.hourly_rate)
      ? body.hourly_rate
      : null;

  const admin = createAdminClient();

  // Invite the user by email. The trigger populates profiles on first
  // sign-in. If already invited, Supabase returns an error we can detect
  // and fall through to just updating the profile row.
  let userId: string | null = null;
  const { data: invited, error: inviteErr } =
    await admin.auth.admin.inviteUserByEmail(email, {
      data: full_name ? { full_name } : {},
    });
  if (invited?.user) {
    userId = invited.user.id;
  } else if (inviteErr) {
    // Try to find the existing user rather than error out — the manager
    // might be re-syncing an already-invited person.
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
    const existing = (list?.users ?? []).find(
      (u) => (u.email ?? "").toLowerCase() === email,
    );
    if (!existing) {
      return NextResponse.json(
        { error: inviteErr.message || "Could not invite user" },
        { status: 400 },
      );
    }
    userId = existing.id;
  }
  if (!userId)
    return NextResponse.json({ error: "No user id returned" }, { status: 500 });

  // Upsert the profile fields. On brand-new invites the trigger may
  // race with our update, so use the service-role client (bypasses RLS)
  // to make the write predictable regardless of trigger timing.
  const supabase = createClient();
  const patch: Record<string, unknown> = {
    id: userId,
    role,
    active: true,
  };
  if (full_name !== null) patch.full_name = full_name;
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

  return NextResponse.json({ ok: true, user_id: userId, email });
}
