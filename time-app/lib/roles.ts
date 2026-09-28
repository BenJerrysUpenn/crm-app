// Who may do what, by profiles.role (migration 31).
//
//   owner:    the business owners. Everything a manager can do, plus the
//              owner-only things: the personal-finance pages in the CRM, and
//              changing an owner's account or granting the owner role.
//   manager:  runs the store: schedule, Team page, timesheets, payroll.
//   employee: clocks in, sees their own schedule and punches.
//
// Every gate in the app asks these functions rather than comparing
// role === "manager", so an owner passes every manager gate by construction.
// The database says the same thing: public.is_manager() is true for owners
// too, and public.is_owner() only for owners.
//
// `active` plays no part in any of this. It means "on the staff roster"; the
// owners are off the roster and still sign in (audit H2).

import type { Role } from "./types.ts";

export const ROLES: readonly Role[] = ["owner", "manager", "employee"];

/** The roles that pass a manager gate. For `.in("role", MANAGER_ROLES)`. */
export const MANAGER_ROLES: Role[] = ["manager", "owner"];

type HasRole = { role: string | null } | null | undefined;

export function isManagerRole(role: string | null | undefined): boolean {
  return role === "manager" || role === "owner";
}

export function isOwnerRole(role: string | null | undefined): boolean {
  return role === "owner";
}

export function isManager(profile: HasRole): boolean {
  return isManagerRole(profile?.role);
}

export function isOwner(profile: HasRole): boolean {
  return isOwnerRole(profile?.role);
}

/** What a refused manager sees. One wording for every route that says no. */
export const OWNER_ONLY_EDIT = "Only an owner can change an owner's account or give someone the owner role.";

/**
 * May `me` change `target`'s profile at all (the Team page row, a re-invite)?
 * Managers may edit anyone except an owner; owners may edit anyone.
 */
export function canEditProfile(me: HasRole, target: HasRole): boolean {
  if (!isManager(me)) return false;
  if (isOwner(target)) return isOwner(me);
  return true;
}

/** The roles `me` may give somebody on the Team page or in an invite. */
export function assignableRoles(me: HasRole): Role[] {
  if (isOwner(me)) return ["employee", "manager", "owner"];
  if (isManager(me)) return ["employee", "manager"];
  return [];
}

export function canAssignRole(me: HasRole, role: unknown): role is Role {
  return typeof role === "string" && (assignableRoles(me) as string[]).includes(role);
}

/**
 * Why `me` may not apply `patch` to `target`'s profile (PATCH /api/profiles/:id),
 * or null when the edit may go ahead. The database refuses the same edits
 * (migration 31, guard_owner_profiles); this says so in words first.
 */
export function profilePatchRefusal(
  me: HasRole,
  target: HasRole,
  patch: Record<string, unknown>,
): string | null {
  if (!canEditProfile(me, target)) return OWNER_ONLY_EDIT;
  if ("role" in patch && patch.role !== target?.role) {
    if (!(ROLES as unknown[]).includes(patch.role)) return "Unknown role.";
    if (!canAssignRole(me, patch.role)) return OWNER_ONLY_EDIT;
  }
  return null;
}
