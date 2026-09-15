// Inviting a person to Withers-time: create the auth user (which fires
// handle_new_user), email the sign-in link, and upsert the profile fields.
//
// Shared by POST /api/profiles (the Team page's Add employee) and the
// onboarding form on /staffing, so both do exactly the same thing. The
// bj-finance onboarding script (modules/onboarding/adapters.py) automates
// Withers-time by POSTing to /api/profiles; this function is what that call
// runs, which is why the staffing flow calls it directly instead of going
// round through HTTP.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendInvite } from "@/lib/authLinks";
import type { Delivery } from "@/lib/authLinks";
import type { Role } from "@/lib/types";

export type InviteInput = {
  email: string;
  full_name: string;
  role?: Role;
  phone?: string | null;
  hourly_rate?: number | null;
  preferred_name?: string | null;
  start_date?: string | null; // YYYY-MM-DD
  invitedBy: string | null;
  origin: string;
};

export type InviteResult =
  | { ok: true; user_id: string; email: string; delivery: Delivery }
  | { ok: false; error: string; status: number };

export function normaliseEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function validName(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.includes("@")) return null;
  return s;
}

export async function inviteTeamMember(input: InviteInput): Promise<InviteResult> {
  const email = normaliseEmail(input.email);
  if (!email || !email.includes("@"))
    return { ok: false, error: "Valid email required", status: 400 };
  // Required. Without it the handle_new_user trigger has no name to store.
  const full_name = validName(input.full_name);
  if (!full_name)
    return { ok: false, error: "Full name required (not an email)", status: 400 };
  const role: Role = input.role === "manager" ? "manager" : "employee";
  const phone = (input.phone ?? "").trim() || null;
  const hourly_rate =
    typeof input.hourly_rate === "number" && !isNaN(input.hourly_rate)
      ? input.hourly_rate
      : null;

  const admin = createAdminClient();

  // Creates the auth user (which fires handle_new_user) and emails the link.
  const invite = await sendInvite({
    email,
    fullName: full_name,
    invitedBy: input.invitedBy,
    origin: input.origin,
  });
  if ("error" in invite) return { ok: false, error: invite.error, status: 400 };

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
  if (!userId) return { ok: false, error: "No user id returned", status: 500 };

  // Upsert the profile fields. On brand-new invites the trigger may race
  // with our update, so use the service-role client (bypasses RLS) to make
  // the write predictable regardless of trigger timing.
  const patch: Record<string, unknown> = {
    id: userId,
    role,
    active: true,
    full_name,
  };
  if (phone !== null) patch.phone = phone;
  if (hourly_rate !== null) patch.hourly_rate = hourly_rate;
  if (input.preferred_name !== undefined)
    patch.preferred_name = (input.preferred_name ?? "").trim() || null;
  if (input.start_date) patch.start_date = input.start_date;

  // Try admin-client upsert first (bypasses RLS); fall back to the server
  // client on any failure.
  let profErr: { message: string } | null = null;
  const { error: adminUpsertErr } = await admin
    .from("profiles")
    .upsert(patch, { onConflict: "id" });
  if (adminUpsertErr) {
    const supabase = createClient();
    const { error: e } = await supabase
      .from("profiles")
      .upsert(patch, { onConflict: "id" });
    profErr = e;
  }
  if (profErr) return { ok: false, error: profErr.message, status: 400 };

  return { ok: true, user_id: userId, email, delivery: invite.delivery };
}
