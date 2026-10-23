import type { Metadata } from "next";
import FinanceShell, { ManagersOnly, financeViewer } from "@/components/finance/FinanceShell";
import MetricsBoard from "@/components/metrics/MetricsBoard";
import { createClient } from "@/lib/supabase/server";
import { buildMetricsData, loadMetricsInputs } from "@/lib/metrics/load";
import { loadViews } from "@/lib/metrics/viewsServer";

export const dynamic = "force-dynamic";
// A cached read would show yesterday's numbers or a view since changed.
export const fetchCache = "force-no-store";

export const metadata: Metadata = { title: "Metrics · Withers Finance" };

// finance.withers-ventures.com/metrics (bj-finance #671): the Metrics board.
// Manager-only, like every finance page: here, in the /api/metrics routes and
// in RLS. Each manager sees their own saved views (lib/metrics/views.ts). The
// numbers the CRM and time clock hold are live; cash, in-store sales, wages
// and the closed months wait on the bj-finance feed (migration 40). On
// localhost and Vercel previews it is at /metrics too.
export default async function MetricsPage() {
  const viewer = await financeViewer();
  if (viewer.access === "refused")
    return <ManagersOnly name={viewer.profile.full_name ?? ""} timeHref={viewer.timeHref} />;

  const supabase = createClient();
  const [inputs, views] = await Promise.all([loadMetricsInputs(supabase), loadViews(supabase, viewer.profile.id)]);
  const data = buildMetricsData(inputs);

  return (
    <FinanceShell tab="metrics" profile={viewer.profile} timeHref={viewer.timeHref}>
      <MetricsBoard data={data} initial={views} userId={viewer.profile.id} />
    </FinanceShell>
  );
}
