import type { Metadata } from "next";
import FinanceShell, { ManagersOnly, financeViewer } from "@/components/finance/FinanceShell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Metrics · Withers Finance" };

// finance.withers-ventures.com/metrics (bj-finance #519): the Metrics board.
// Manager-only, like every finance page. On localhost and Vercel previews it is
// at /metrics too.
export default async function MetricsPage() {
  const viewer = await financeViewer();
  if (viewer.access === "refused")
    return <ManagersOnly name={viewer.profile.full_name ?? ""} timeHref={viewer.timeHref} />;

  return (
    <FinanceShell tab="metrics" profile={viewer.profile} timeHref={viewer.timeHref}>
      <MetricsPlaceholder />
    </FinanceShell>
  );
}

function MetricsPlaceholder() {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Metrics board</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400 mt-2 max-w-prose">
        Not built yet. The tab exists so the Finance section has the shape
        bj-finance #519 describes, and so the payroll work has somewhere to sit
        beside it. Nothing here reads or writes anything.
      </p>
    </div>
  );
}
