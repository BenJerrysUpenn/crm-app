import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { loadQueue } from "@/lib/reimbursements/load";
import { isOwner } from "@/lib/reimbursements/lifecycle";
import FinanceShell, { ManagersOnly, financeViewer } from "@/components/finance/FinanceShell";
import ReimbursementQueue from "@/components/finance/ReimbursementQueue";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Reimbursements · Withers Finance" };

// finance.withers-ventures.com/payroll/reimbursements (bj-finance #210, ruling
// 21): the Approvers' queue of Travel Reimbursements. Approvers are managers
// and owners, the finance site's own gate (financeViewer); who may decide
// which is lib/reimbursements/lifecycle.ts, again in every route behind it.
export default async function ReimbursementsQueuePage() {
  const viewer = await financeViewer();
  if (viewer.access === "refused")
    return <ManagersOnly name={viewer.profile.full_name ?? ""} timeHref={viewer.timeHref} />;

  const queue = await loadQueue(createClient(), viewer.profile);
  return (
    <FinanceShell tab="reimbursements" profile={viewer.profile} timeHref={viewer.timeHref}>
      {queue.ok ? (
        <ReimbursementQueue submitted={queue.submitted} approved={queue.approved} decided={queue.decided} viewerIsOwner={isOwner(viewer.profile)} />
      ) : (
        <div className="text-sm text-slate-600 dark:text-slate-400">Reimbursements are not available yet: {queue.error}</div>
      )}
    </FinanceShell>
  );
}
