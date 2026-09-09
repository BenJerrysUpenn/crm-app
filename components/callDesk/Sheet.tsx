"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Bottom sheet on mobile, centred modal from `sm` up. Used by the
 * disposition and note sheets so both behave identically under a thumb.
 *
 * Dismissal is deliberately explicit — tapping the backdrop closes, but the
 * disposition sheet treats "closed without an outcome" as still-pending and
 * re-offers itself, so nothing is lost either way.
 */
export default function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto bg-slate-900 border-t sm:border border-slate-700 sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-slate-100 font-semibold truncate">{title}</h2>
            {subtitle && (
              <p className="text-xs text-slate-500 truncate">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 min-h-[44px] min-w-[44px] -mr-2 -mt-2 text-slate-400 hover:text-slate-200 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="px-4 py-4 pb-8 sm:pb-4">{children}</div>
      </div>
    </div>
  );
}
