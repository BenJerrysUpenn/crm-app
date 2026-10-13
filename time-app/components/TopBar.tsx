"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { Role } from "@/lib/types";
import { displayName } from "@/lib/profileName";
import NotificationBell from "@/components/NotificationBell";
import ThemeToggle from "@/components/ThemeToggle";

// Account has no tab in the desktop row: from the md breakpoint up, the name at
// the right of the bar links to /account. Below md the name is hidden and the
// hamburger menu takes over the nav, keeping an Account entry (mobileOnly). The
// row, the name and the hamburger must switch at the same breakpoint, or some
// width is left with no route to /account.
const ACCOUNT_HREF = "/account";

const links: { href: string; label: string; managerOnly?: boolean; mobileOnly?: boolean }[] = [
  { href: "/", label: "Clock" },
  { href: "/schedule", label: "Schedule" },
  { href: "/availability", label: "Availability" },
  { href: "/timesheets", label: "Timesheets" },
  { href: "/reimbursements", label: "Reimbursements" },
  { href: "/attendance", label: "Attendance", managerOnly: true },
  { href: "/team", label: "Team", managerOnly: true },
  { href: ACCOUNT_HREF, label: "Account", mobileOnly: true },
];

export default function TopBar({
  role,
  name,
}: {
  role: Role;
  name: string | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const visible = links.filter((l) => !l.managerOnly || role === "manager");
  // The name is the desktop route to /account, so it must never render blank —
  // and never the login email. displayName falls back to a neutral label.
  const accountLabel = displayName(name);

  function isActive(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  return (
    <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 backdrop-blur sticky top-0 z-20">
      <div className="mx-auto max-w-5xl px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-4">
        {/* Hamburger (below md) */}
        <button
          onClick={() => setOpen((o) => !o)}
          className="md:hidden text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 p-1 -ml-1"
          aria-label="Menu"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {open ? (
              <path d="M18 6 6 18M6 6l12 12" />
            ) : (
              <path d="M3 12h18M3 6h18M3 18h18" />
            )}
          </svg>
        </button>

        <div className="font-semibold text-slate-900 dark:text-slate-100 shrink-0">Withers Time</div>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1 flex-1 overflow-x-auto">
          {visible.filter((l) => !l.mobileOnly).map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-1.5 rounded-md text-sm whitespace-nowrap ${
                isActive(l.href)
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium"
                  : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        {/* Spacer on mobile to push the right cluster over */}
        <div className="flex-1 md:hidden" />

        <ThemeToggle />
        <NotificationBell />

        <Link
          href={ACCOUNT_HREF}
          title={accountLabel}
          className="hidden md:flex flex-col items-end min-w-0 max-w-[10rem] leading-tight hover:opacity-80"
        >
          <span className="max-w-full truncate text-xs text-slate-700 dark:text-slate-300">{accountLabel}</span>
          <span className="text-[10px] text-slate-500 capitalize">{role} · account</span>
        </Link>

        <form action="/api/logout" method="post">
          <button className="text-xs text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1 whitespace-nowrap">
            Sign out
          </button>
        </form>
      </div>

      {/* Mobile dropdown menu */}
      {open && (
        <nav className="md:hidden border-t border-slate-200 dark:border-slate-800 px-2 py-2 flex flex-col gap-1">
          {visible.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className={`px-3 py-2 rounded-md text-sm ${
                isActive(l.href)
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium"
                  : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
