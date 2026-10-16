"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { Role } from "@/lib/types";
import { isManagerRole } from "@/lib/roles";
import NotificationBell from "@/components/NotificationBell";
import ThemeToggle from "@/components/ThemeToggle";

// Layout: everything is left-aligned. "Withers Time" sits at the left edge,
// the tabs follow it, and the right-hand controls (theme, bell, name, Sign out)
// sit at the right edge. The tab row never scrolls and is never clipped: it is
// shown only from the xl breakpoint (1280px), the narrowest width at which the
// manager's full row fits on one line beside the brand and the right-hand
// controls. Below xl a hamburger takes the row's place and opens a menu of the
// same tabs.
//
// Account has no tab in the row: from the md breakpoint up, the name at the
// right of the bar links to /account. Below md the name is hidden, so the
// hamburger menu keeps an Account entry (mobileOnly). The hamburger shows at
// every width below xl, which covers every width the name link does not.
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
  email,
  role,
  name,
}: {
  email: string;
  role: Role;
  name: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const visible = links.filter((l) => !l.managerOnly || isManagerRole(role));
  // The name is the desktop route to /account, so it must never render blank.
  const accountLabel = name || email || "Account";

  // While the menu is open: Escape closes it (focus back on the hamburger), and
  // a tap anywhere outside the menu and the hamburger closes it.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    function onPointer(e: Event) {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  function isActive(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  return (
    <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 backdrop-blur sticky top-0 z-20">
      <div className="px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-4">
        <div className="font-semibold text-slate-900 dark:text-slate-100 shrink-0">Withers Time</div>

        {/* Tab row (xl and up) */}
        <nav aria-label="Main" className="hidden xl:flex flex-wrap items-center gap-1 min-w-0">
          {visible.filter((l) => !l.mobileOnly).map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={isActive(l.href) ? "page" : undefined}
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

        {/* Hamburger (below xl), in the tab row's place */}
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="xl:hidden text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 p-1"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls={menuId}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            {open ? (
              <path d="M18 6 6 18M6 6l12 12" />
            ) : (
              <path d="M3 12h18M3 6h18M3 18h18" />
            )}
          </svg>
        </button>

        {/* The menu follows the hamburger in the tab order; it drops down
            below the bar, over the page. */}
        {open && (
          <nav
            ref={menuRef}
            id={menuId}
            aria-label="Menu"
            className="xl:hidden absolute left-0 right-0 top-full border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg px-2 py-2 flex flex-col gap-1"
          >
            {visible.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                aria-current={isActive(l.href) ? "page" : undefined}
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

        <div className="flex-1" />

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
    </header>
  );
}
