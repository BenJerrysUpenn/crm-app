// Who may see the finance pages and their APIs (bj-finance #519): active
// managers only. Pay is not something an employee sees a corner of, and a
// deactivated manager is no longer entitled to it either.
//
// One rule for the pages (app/payroll, app/metrics) and every /api/payroll
// handler, so the two cannot drift. Row Level Security behind them is the
// second line, not a substitute.

export type FinanceAccess = "sign_in" | "refused" | "allowed";

export function financeAccess(profile: { role: string; active: boolean } | null): FinanceAccess {
  if (!profile) return "sign_in";
  if (profile.role !== "manager" || profile.active === false) return "refused";
  return "allowed";
}
