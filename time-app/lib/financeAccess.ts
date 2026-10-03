// Who may see the finance pages and their APIs (bj-finance #519): managers
// only. Pay is not something an employee sees a corner of.
//
// `active` is deliberately NOT checked. It means "on the staff roster", and the
// owners are managers kept off the roster (active = false) so they never appear
// on schedules or payroll. Offboarding a manager demotes their role to
// employee and bans the login, so role alone is the gate.
//
// One rule for the pages (app/payroll, app/metrics) and every /api/payroll
// handler, so the two cannot drift. Row Level Security behind them is the
// second line, not a substitute.

export type FinanceAccess = "sign_in" | "refused" | "allowed";

export function financeAccess(profile: { role: string; active: boolean } | null): FinanceAccess {
  if (!profile) return "sign_in";
  if (profile.role !== "manager") return "refused";
  return "allowed";
}
