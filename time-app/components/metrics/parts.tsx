"use client";

// Small pieces every Metrics widget is built from (bj-finance #671).

import type { ReactNode } from "react";

export function Tile({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 px-3 py-2 min-w-0">
      <div className="text-xs text-slate-600 dark:text-slate-400">{label}</div>
      <div className="text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50 mt-0.5 whitespace-nowrap">{value}</div>
      {sub && <div className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

export function Tiles({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-3">{children}</div>;
}

/** What a widget whose numbers come from the bj-finance feed shows until the feed runs. */
export function WaitingOnFeed({ what, detail }: { what: string; detail?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-3 py-2">
      <p className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span>
          <span className="font-medium">Waiting on the finance feed.</span> {what}
        </span>
      </p>
      {detail && <Method>{detail}</Method>}
    </div>
  );
}

export function CouldNotLoad({ what }: { what: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-4 py-2 text-sm text-amber-900 dark:text-amber-200">
      <span>Could not load {what}.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="min-h-[44px] px-3 rounded-md border border-amber-400 dark:border-amber-700 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
      >
        Try again
      </button>
    </div>
  );
}

/** One plain line under a chart. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-slate-600 dark:text-slate-400 mt-2 max-w-prose">{children}</p>;
}

/** How a number is worked out, closed by default. */
export function Method({ children, label = "How this is worked out" }: { children: ReactNode; label?: string }) {
  return (
    <details className="mt-1 text-xs text-slate-600 dark:text-slate-400 max-w-prose">
      <summary className="cursor-pointer min-h-[44px] inline-flex items-center underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded">
        {label}
      </summary>
      <div className="space-y-1.5 pb-1">{children}</div>
    </details>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-600 dark:text-slate-400 py-6 text-center">{children}</p>;
}
