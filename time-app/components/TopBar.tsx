"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/lib/types";
import NotificationBell from "@/components/NotificationBell";

const links: { href: string; label: string; managerOnly?: boolean }[] = [
  { href: "/", label: "Clock" },
  { href: "/schedule", label: "Schedule" },
  { href: "/availability", label: "Availability" },
  { href: "/timesheets", label: "Timesheets" },
  { href: "/team", label: "Team", managerOnly: true },
  { href: "/account", label: "Account" },
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
  return (
    <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-20">
      <div className="mx-auto max-w-5xl px-4 py-3 flex items-center gap-4">
        <div className="font-semibold text-slate-100 shrink-0">Withers Time</div>
        <nav className="flex items-center gap-1 overflow-x-auto flex-1">
          {links
            .filter((l) => !l.managerOnly || role === "manager")
            .map((l) => {
              const active =
                l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`px-3 py-1.5 rounded-md text-sm whitespace-nowrap ${
                    active
                      ? "bg-slate-100 text-slate-900 font-medium"
                      : "text-slate-300 hover:bg-slate-800"
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
        </nav>
        <NotificationBell />
        <Link href="/account" className="hidden sm:flex flex-col items-end leading-tight hover:opacity-80">
          <span className="text-xs text-slate-300">{name || email}</span>
          <span className="text-[10px] text-slate-500 capitalize">{role} · account</span>
        </Link>
        <form action="/api/logout" method="post">
          <button className="text-xs text-slate-400 hover:text-slate-200 border border-slate-700 rounded-md px-2 py-1">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
