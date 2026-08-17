"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Top bar for the personal-finance pages. Mirrors the CRM TopBar styling but
// keeps its own tab set (the CRM board bar stays untouched).
export default function PfTopBar({ email }: { email: string }) {
  const pathname = usePathname();

  const tabs = [
    { href: "/money", label: "Money explorer" },
    { href: "/dial", label: "Decision dial" },
    { href: "/safe", label: "Safe to spend" },
  ];

  return (
    <header className="bg-slate-950 border-b border-slate-800 px-6 py-2 flex items-center justify-between flex-wrap gap-2">
      <div className="flex items-center gap-6">
        <h1 className="font-semibold text-slate-100">Withers finance</h1>
        <nav className="flex items-center gap-1">
          {tabs.map((tab) => {
            const active = pathname.startsWith(tab.href);
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
        <Link
          href="/"
          className="text-sm text-slate-400 hover:text-slate-200 transition"
        >
          CRM board
        </Link>
        <span className="text-sm text-slate-400 hidden sm:inline">{email}</span>
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
