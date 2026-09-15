import { getProfile } from "@/lib/auth";
import { siteOrigin } from "@/lib/authLinks";
import { inviteTeamMember } from "@/lib/team";
import { NextResponse } from "next/server";

// POST /api/profiles
//
// Manager-only. Creates a new team member by inviting them to sign up via
// their email address. The app emails the invite link itself via Resend and
// the link lands on /auth/confirm (falls back to a Supabase-sent invite when
// RESEND_API_KEY is unset). When they set a password and log in for the first
// time, the `handle_new_user` trigger on the auth.users table creates the
// corresponding profiles row.
//
// Body:
//   { email: string, full_name: string, role?: 'employee'|'manager',
//     phone?: string, hourly_rate?: number }
//
// If the auth user already exists (someone re-invited), we still upsert
// their profile fields so the manager's input isn't lost.
//
// The work itself lives in lib/team.ts (inviteTeamMember) so the Team page's
// Add employee and Re-invite steps (lib/staffing/execute.ts) run the
// identical path.
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

  const r = await inviteTeamMember({
    email: body.email ?? "",
    full_name: body.full_name ?? "",
    role: body.role,
    phone: body.phone,
    hourly_rate: body.hourly_rate,
    invitedBy: me.full_name,
    origin: siteOrigin(request),
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });

  return NextResponse.json({
    ok: true,
    user_id: r.user_id,
    email: r.email,
    delivery: r.delivery,
  });
}
