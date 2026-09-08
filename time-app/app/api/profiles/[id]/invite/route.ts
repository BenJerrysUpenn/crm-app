import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import { sendInvite, siteOrigin } from "@/lib/authLinks";

// POST /api/profiles/:id/invite
// Manager-only. Resends a sign-in link to an existing team member (an invite
// that expired, or someone who never set a password). Lands on set-password.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const admin = createAdminClient();
  const { data: u, error: uErr } = await admin.auth.admin.getUserById(params.id);
  if (uErr || !u.user?.email)
    return NextResponse.json({ error: "No login email on file for this person" }, { status: 404 });

  const { data: p } = await admin
    .from("profiles")
    .select("full_name")
    .eq("id", params.id)
    .maybeSingle();

  const r = await sendInvite({
    email: u.user.email,
    fullName: p?.full_name ?? null,
    invitedBy: me.full_name,
    origin: siteOrigin(request),
  });
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, email: u.user.email, delivery: r.delivery });
}
