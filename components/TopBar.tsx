"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function TopBar({ email }: { email: string }) {
  const pathname = usePathname();

  const tabs = [
    { href: "/", label: "Board" },
    { href: "/calendar", label: "Calendar" },
    { href: "/historical", label: "Historical" },
    { href: "/price-book", label: "Price book" },
    { href: "/call-desk", label: "Call desk" },
  ];

  return (
    // Narrow screens (the call desk is phone-first): the bar wraps, the tab
    // row scrolls sideways on its own rather than pushing the page wide, and
    // the signed-in email drops out below `sm` to leave room for Sign out.
    <header className="bg-slate-950 border-b border-slate-800 px-3 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-y-1 gap-x-3">
      <div className="flex items-center gap-3 sm:gap-6 min-w-0 order-1">
        <h1 className="font-semibold text-slate-100 whitespace-nowrap">
          Withers CRM
        </h1>
      </div>
      <nav className="flex items-center gap-1 order-3 w-full sm:order-2 sm:w-auto sm:flex-1 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => {
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`text-sm px-3 py-1.5 rounded-md transition whitespace-nowrap ${
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
      <div className="flex items-center gap-4 order-2 sm:order-3">
        <span className="hidden sm:inline text-sm text-slate-400 truncate max-w-[16rem]">
          {email}
        </span>
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
