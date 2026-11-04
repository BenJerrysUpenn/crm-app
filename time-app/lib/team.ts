// Inviting a person to Withers-time: create the auth user (which fires
// handle_new_user), email the sign-in link, and upsert the profile fields.
//
// Shared by POST /api/profiles and the Team page's Add employee / Re-invite
// steps (lib/staffing/execute.ts, withers_time_invite), so both do exactly
// the same thing. The bj-finance onboarding script
// (modules/onboarding/adapters.py) automates Withers-time by POSTing to
// /api/profiles; this function is what that call runs, which is why the
// staffing steps call it directly instead of going round through HTTP.
//
// Every write below goes through the service role, which the database's
// owner guard (migration 42) trusts, so the owner rules are checked here,
// before anything is sent: only an owner may give the owner role, and only
// an owner may re-invite an owner's account (lib/roles.ts).
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendInvite } from "@/lib/authLinks";
import type { Delivery } from "@/lib/authLinks";
import { canAssignRole, canEditProfile, isRole, OWNER_ONLY_EDIT } from "@/lib/roles";
import { validateFullName, normalizePhone } from "@/lib/profileName";
import type { Role } from "@/lib/types";

// Who is sending the invite: their role decides what they may do, their
// name goes on the email.
export type Inviter = { role: string | null; full_name: string | null };

export type InviteInput = {
  email: string;
  full_name: string;
  role?: unknown;
  phone?: string | null;
  hourly_rate?: number | null;
  preferred_name?: string | null;
  start_date?: string | null; // YYYY-MM-DD
  me: Inviter;
  origin: string;
};

export type InviteResult =
  | { ok: true; user_id: string; email: string; delivery: Delivery }
  | { ok: false; error: string; status: number };

// Trimmed and lower-cased; null unless it contains an "@".
export function validEmail(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  return s.includes("@") ? s : null;
}

export function validName(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.includes("@")) return null;
  return s;
}

// Anything unrecognised is an employee. Whether the inviter may give the
// role is canAssignRole's question, not this one's.
export function normaliseRole(raw: unknown): Role {
  return isRole(raw) ? raw : "employee";
}

export async function inviteTeamMember(input: InviteInput): Promise<InviteResult> {
  const email = validEmail(input.email);
  if (!email)
    return { ok: false, error: "Valid email required", status: 400 };
  // Required, and held to the one name rule every write path shares
  // (lib/profileName.ts): trimmed, not an email, at most 100 characters, with
  // the same messages as the Team page's PATCH and PATCH /api/account. Without
  // a name the handle_new_user trigger has nothing to store. (validName below
  // stays for the staffing forms' legal_name, a separate field.)
  const name = validateFullName(input.full_name);
  if (!name.ok) return { ok: false, error: name.error, status: 400 };
  const full_name = name.name;
  const role = normaliseRole(input.role);
  if (!canAssignRole(input.me, role))
    return { ok: false, error: OWNER_ONLY_EDIT, status: 403 };
  const phone = normalizePhone(input.phone);
  const hourly_rate =
    typeof input.hourly_rate === "number" && !isNaN(input.hourly_rate)
      ? input.hourly_rate
      : null;

  const admin = createAdminClient();

  // Re-inviting an existing account rewrites its role and active flag below,
  // so a manager is refused here, before anything is sent, when the email
  // belongs to an owner.
  const { data: before } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const existing = (before?.users ?? []).find(
    (u) => (u.email ?? "").toLowerCase() === email,
  );
  if (existing) {
    const { data: existingProfile } = await admin
      .from("profiles")
      .select("role")
      .eq("id", existing.id)
      .maybeSingle();
    if (!canEditProfile(input.me, existingProfile))
      return { ok: false, error: OWNER_ONLY_EDIT, status: 403 };
  }

  // Creates the auth user (which fires handle_new_user) and emails the link.
  const invite = await sendInvite({
    email,
    fullName: full_name,
    invitedBy: input.me.full_name,
    origin: input.origin,
  });
  if ("error" in invite) return { ok: false, error: invite.error, status: 400 };

  // A re-invite goes out as a magic link, which doesn't always carry the
  // user back, so look the existing account up by email in that case.
  let userId = invite.userId ?? existing?.id ?? null;
  if (!userId) {
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const created = (list?.users ?? []).find(
      (u) => (u.email ?? "").toLowerCase() === email,
    );
    userId = created?.id ?? null;
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
