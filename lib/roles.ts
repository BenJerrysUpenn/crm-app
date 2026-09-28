// Who may use the CRM, by profiles.role (time-app migration 31).
//
//   owner:    the business owners. Everything a manager can do, plus the
//             personal-finance pages (/money, /dial, /safe).
//   manager:  the CRM board, call desk, deals, email campaigns.
//   employee: nothing here; they use the time app.
//
// The same rules live in time-app/lib/roles.ts for the time app. `active` is
// not consulted anywhere: it means "on the staff roster" and the owners are
// off the roster (audit H2).

export function isManagerRole(role: string | null | undefined): boolean {
  return role === "manager" || role === "owner";
}

export function isOwnerRole(role: string | null | undefined): boolean {
  return role === "owner";
}

// The personal-finance pages. Served on their own host (middleware.ts) and
// readable by the owners only.
export const PF_ROUTES = ["/money", "/dial", "/safe"];

export function isPfPath(pathname: string): boolean {
  return PF_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * The CRM's role gate for a signed-in person (lib/supabase/middleware.ts):
 * the personal-finance pages need an owner, everything else a manager or an
 * owner.
 */
export function crmAccess(pathname: string, role: string | null | undefined): "allowed" | "refused" {
  if (isPfPath(pathname)) return isOwnerRole(role) ? "allowed" : "refused";
  return isManagerRole(role) ? "allowed" : "refused";
}
