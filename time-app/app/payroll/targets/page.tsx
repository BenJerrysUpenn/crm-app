import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/roles";
import { nyToday } from "@/lib/metrics/dates";
import { loadBoard } from "@/lib/controlBoard/load";
import { loadPlanningInputs } from "@/lib/controlBoard/planningInputsLoad";
import FinanceShell, { ManagersOnly, financeViewer } from "@/components/finance/FinanceShell";
import ControlBoard from "@/components/finance/targets/ControlBoard";
import PlanningInputs from "@/components/finance/targets/PlanningInputs";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Targets · Withers Finance" };

// finance.withers-ventures.com/payroll/targets (bj-finance #693): the control
// board, the Targets tab. Managers and owners see it (the finance site's gate);
// owners change its values, everyone else views (lib/roles.ts here, the
// route behind the Save button, and migration 43's policies). Lives under
// /payroll, like Reimbursements, so the finance host serves it and its API
// with no change to lib/hosts.ts. Below the board, the Labor Hours Planning
// inputs (bj-finance #742): seasons and events, which owners change, and
// closed days, which any manager sets.
export default async function TargetsPage() {
  const viewer = await financeViewer();
  if (viewer.access === "refused")
    return <ManagersOnly name={viewer.profile.full_name ?? ""} timeHref={viewer.timeHref} />;

  const today = nyToday();
  const supabase = createClient();
  const [board, inputs] = await Promise.all([loadBoard(supabase, today), loadPlanningInputs(supabase, today)]);
  return (
    <FinanceShell tab="targets" profile={viewer.profile} timeHref={viewer.timeHref}>
      {board.ready ? (
        <ControlBoard
          settings={board.settings}
          salaries={board.salaries}
          salaried={board.salaried}
          monthly={board.monthly}
          daily={board.daily}
          problems={board.problems}
          today={today}
          viewerIsOwner={isOwner(viewer.profile)}
          teamHref={`${viewer.timeHref.replace(/\/$/, "")}/team`}
        />
      ) : (
        <div className="text-sm text-slate-600 dark:text-slate-400">The control board is not available yet: {board.reason}</div>
      )}
      <PlanningInputs data={inputs} today={today} viewerIsOwner={isOwner(viewer.profile)} />
    </FinanceShell>
  );
}
