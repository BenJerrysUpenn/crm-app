import type { Metadata } from "next";
import { dayKey } from "@/lib/format";
import { mostRecentPeriodEnd } from "@/lib/payroll/window";
import FinanceShell, { ManagersOnly, financeViewer } from "@/components/finance/FinanceShell";
import PayrollVerify from "@/components/finance/PayrollVerify";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Payroll · Withers Finance" };

// finance.withers-ventures.com/payroll (bj-finance #519, ruled 2026-09-27):
// the payroll prototype, formerly the Payroll tab of time.withers-ventures.com/finance.
// Manager-only, twice over: financeViewer here, and every /api/payroll route and
// RLS policy behind it. On localhost and Vercel previews it is at /payroll too.
export default async function PayrollPage() {
  const viewer = await financeViewer();
  if (viewer.access === "refused")
    return <ManagersOnly name={viewer.profile.full_name ?? ""} timeHref={viewer.timeHref} />;

  const defaultWindowEnd = mostRecentPeriodEnd(dayKey(new Date().toISOString()));
  return (
    <FinanceShell tab="payroll" profile={viewer.profile} timeHref={viewer.timeHref}>
      <PayrollVerify defaultWindowEnd={defaultWindowEnd} meId={viewer.profile.id} />
    </FinanceShell>
  );
}
