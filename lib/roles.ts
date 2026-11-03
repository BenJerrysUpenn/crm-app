// Who may use the CRM, by profiles.role (time-app migration 42).
//
//   owner:    the business owners. Everything a manager can do, plus the
//             personal-finance pages (/money, /dial, /safe; lib/pf/access.ts).
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
// readable by the owners only: lib/pf/access.ts answers anyone else with a 404.
const PF_ROUTES = ["/money", "/dial", "/safe"];

export function isPfPath(pathname: string): boolean {
  return PF_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// The personal-finance API, under one prefix: the /money change-category
// button posts to /api/pf/overrides (bj-finance #223). "/api/pfx" and the like
// are not pf routes.
const PF_API_PREFIX = "/api/pf";

// The whole pf route set — the pages above and the API — named once, here. The
// PF-host bounce and the CRM-host redirect (middleware.ts) decide "which paths
// are pf" from this function instead of repeating the /api/pf prefix inline, so
// the two cannot drift apart — the same reason isGateExempt lives here.
export function isPfRoute(pathname: string): boolean {
  return (
    isPfPath(pathname) ||
    pathname === PF_API_PREFIX ||
    pathname.startsWith(`${PF_API_PREFIX}/`)
  );
}

// Paths a signed-in person the role gate refuses must still reach: the
// no-access page they are sent to, and sign-out. Listed once here so the
// PF-host bounce (middleware.ts) and the role gate (lib/supabase/middleware.ts)
// cannot drift — if they did, a refused employee loops between /safe and
// /no-access, and sign-out breaks on the PF host.
export function isGateExempt(pathname: string): boolean {
  return pathname === "/no-access" || pathname.startsWith("/api/logout");
}
