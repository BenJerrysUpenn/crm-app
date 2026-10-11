// Small pieces every Metrics widget is built from (bj-finance #671).

import type { ReactNode } from "react";

export function Tile({ label, value, sub, tone = "plain" }: { label: string; value: string; sub?: ReactNode; tone?: "plain" | "good" | "serious" }) {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 px-3 py-2 min-w-0">
      <div className="text-xs text-slate-600 dark:text-slate-400">{label}</div>
      <div className="text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50 mt-0.5 break-words">
        {tone !== "plain" && (
          <span
            aria-hidden="true"
            className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
            style={{ background: tone === "good" ? "var(--m-good)" : "var(--m-serious)" }}
          />
        )}
        {value}
      </div>
      {sub && <div className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

export function Tiles({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-3">{children}</div>;
}

/** What a widget whose numbers come from the bj-finance feed shows until the feed runs. */
export function WaitingOnFeed({ what, children }: { what: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-4 py-4">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        Waiting on the finance feed
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 max-w-prose">{what}</p>
      {children}
    </div>
  );
}

export function CouldNotLoad({ what }: { what: string }) {
  return (
    <div role="alert" className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
      Could not load {what}. Reload the page to try again.
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-slate-600 dark:text-slate-400 mt-2 max-w-prose">{children}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-600 dark:text-slate-400 py-6 text-center">{children}</p>;
}
