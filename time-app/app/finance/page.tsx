import Link from "next/link";
import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { dayKey } from "@/lib/format";
import { mostRecentSunday } from "@/lib/payroll/window";
import TopBar from "@/components/TopBar";
import PayrollVerify from "@/components/finance/PayrollVerify";

export const dynamic = "force-dynamic";

// The Finance tab (bj-finance #519): "a Finance tab at
// finance.withers-ventures.com, only available to managers. One of its tabs is
// Payroll. Another tab will be the Metrics board."
//
// Two sub-tabs, addressed by ?tab= so each is a link a manager can bookmark and
// the server renders the right one on a cold load. Payroll is the one with
// something in it; Metrics is a named placeholder rather than a hidden plan.
const TABS = [
  { id: "payroll", label: "Payroll" },
  { id: "metrics", label: "Metrics" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default async function FinancePage({
  searchParams,
}: {
  searchParams?: { tab?: string };
}) {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  // Manager-only, twice over: this redirect, and every route and RLS policy
  // behind it. Pay is not something an employee sees a corner of.
  if (profile.role !== "manager") redirect("/");

  const tab: TabId = searchParams?.tab === "metrics" ? "metrics" : "payroll";
  const defaultWindowEnd = mostRecentSunday(dayKey(new Date().toISOString()));

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-3">Finance</h1>

          <nav className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 mb-5">
            {TABS.map((t) => (
              <Link
                key={t.id}
                href={`/finance?tab=${t.id}`}
                className={`px-3 py-2 text-sm -mb-px border-b-2 ${
                  tab === t.id
                    ? "border-emerald-500 text-slate-900 dark:text-slate-100 font-medium"
                    : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                {t.label}
              </Link>
            ))}
          </nav>

          {tab === "payroll" ? (
            <PayrollVerify defaultWindowEnd={defaultWindowEnd} meId={profile.id} />
          ) : (
            <MetricsPlaceholder />
          )}
        </div>
      </main>
    </div>
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
