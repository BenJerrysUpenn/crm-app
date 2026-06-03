"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function TopBar({ email }: { email: string }) {
  const pathname = usePathname();

  const tabs = [
    { href: "/", label: "Board" },
    { href: "/historical", label: "Historical" },
  ];

  return (
    <header className="bg-slate-950 border-b border-slate-800 px-6 py-2 flex items-center justify-between">
      <div className="flex items-center gap-6">
        <h1 className="font-semibold text-slate-100">Withers CRM</h1>
        <nav className="flex items-center gap-1">
          {tabs.map((tab) => {
            const active =
              tab.href === "/"
                ? pathname === "/"
                : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`text-sm px-3 py-1.5 rounded-md transition ${
                  active
                    ? "bg-slate-800 text-slate-100"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-slate-400">{email}</span>
        <form action="/api/logout" method="post">
          <button
            type="submit"
            className="text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md px-3 py-1.5 border border-slate-700"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
