import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { timeHomeHref } from "@/lib/hosts";
import type { Profile } from "@/lib/types";
import ThemeToggle from "@/components/ThemeToggle";

// The frame of the finance site (finance.withers-ventures.com, bj-finance #519):
// its own header with the Payroll and Metrics tabs, a link back to Withers
// Time, and the managers-only gate every finance page goes through.

export type FinanceTab = "payroll" | "metrics";

const TABS: { id: FinanceTab; label: string; href: string }[] = [
  { id: "payroll", label: "Payroll", href: "/payroll" },
  { id: "metrics", label: "Metrics", href: "/metrics" },
];

/**
 * The signed-in manager, or a reason not to render. Signed out goes to the
 * login page on this host. A signed-in non-manager is refused in the page, not
 * redirected: on the finance host "/" is /payroll, so redirecting home would
 * loop.
 */
export async function financeViewer(): Promise<
  { access: "allowed"; profile: Profile; timeHref: string } | { access: "refused"; profile: Profile; timeHref: string }
> {
  const profile = await getProfile();
  const access = financeAccess(profile);
  if (access === "sign_in" || !profile) redirect("/login");
  const timeHref = timeHomeHref(headers().get("host"));
  return { access, profile, timeHref };
}

export default function FinanceShell({
  tab,
  profile,
  timeHref,
  children,
}: {
  tab: FinanceTab;
  profile: Profile;
  timeHref: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <FinanceBar name={profile.full_name ?? ""} timeHref={timeHref} />
      <main className="flex-1">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <nav className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 mb-5">
            {TABS.map((t) => (
              <Link
                key={t.id}
                href={t.href}
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
          {children}
        </div>
      </main>
    </div>
  );
}

function FinanceBar({ name, timeHref }: { name: string; timeHref: string }) {
  return (
    <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 backdrop-blur sticky top-0 z-20">
      <div className="mx-auto max-w-5xl px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-4">
        <div className="font-semibold text-slate-900 dark:text-slate-100 shrink-0">Withers Finance</div>
        <div className="flex-1" />
        {/* A plain link: on the finance host Withers Time is another site. */}
        <a
          href={timeHref}
          className="text-sm text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap"
        >
          Withers Time
        </a>
        <ThemeToggle />
        {name && <span className="hidden md:inline text-xs text-slate-700 dark:text-slate-300">{name}</span>}
        <form action="/api/logout" method="post">
          <button className="text-xs text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1 whitespace-nowrap">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

/** What a signed-in person who is not an active manager sees on any finance page. */
export function ManagersOnly({ name, timeHref }: { name: string; timeHref: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-950 px-4">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl p-8 w-full max-w-sm space-y-3 border border-slate-200 dark:border-slate-800">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Withers Finance</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Finance is for managers only.{name ? ` You are signed in as ${name}.` : ""}
        </p>
        <div className="flex items-center gap-3 pt-1">
          <a href={timeHref} className="text-sm underline text-slate-700 dark:text-slate-300">
            Go to Withers Time
          </a>
          <form action="/api/logout" method="post">
            <button className="text-xs text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
