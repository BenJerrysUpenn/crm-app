"use client";

import Sheet from "./Sheet";
import {
  facetCounts,
  isSelected,
  visibleFacets,
  type FacetKey,
  type FacetSelection,
} from "@/lib/callDesk/filters";
import type { CallDeskRow } from "@/lib/callDesk/types";

/**
 * The facet picker (bj-finance #412). One group of chips per facet, counts
 * measured against the other facets so a number says what picking it leaves.
 *
 * Serves both layouts: the desktop table has no filter UI of its own.
 */
export default function FilterSheet({
  rows,
  selection,
  resultCount,
  onToggle,
  onClear,
  onClose,
}: {
  /** The whole queue, unfiltered — counts and the hide-a-dead-facet rule need it. */
  rows: CallDeskRow[];
  selection: FacetSelection;
  resultCount: number;
  onToggle: (key: FacetKey, value: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const facets = visibleFacets(rows, selection);

  return (
    <Sheet
      title="Filter"
      subtitle={`${rows.length} in the queue`}
      onClose={onClose}
    >
      {facets.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nothing to filter by yet — every row in the queue looks the same.
        </p>
      ) : (
        <div className="space-y-5">
          {facets.map((facet) => {
            const counts = facetCounts(rows, selection, facet.key);
            return (
              <div key={facet.key}>
                <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">
                  {facet.label}
                </div>
                <div className="flex flex-wrap gap-2">
                  {counts.map((c) => {
                    const on = isSelected(selection, facet.key, c.value);
                    return (
                      <button
                        key={c.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onToggle(facet.key, c.value)}
                        className={`min-h-[44px] px-3 text-sm rounded-full border transition ${
                          on
                            ? "bg-emerald-600/25 text-emerald-100 border-emerald-500"
                            : "bg-slate-950 text-slate-300 border-slate-700 hover:border-slate-500"
                        }`}
                      >
                        {c.label}{" "}
                        <span
                          className={on ? "text-emerald-300/80" : "text-slate-500"}
                        >
                          · {c.count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-6 flex gap-2 sticky bottom-0 bg-slate-900 pt-3">
        <button
          type="button"
          onClick={onClear}
          className="min-h-[44px] px-4 text-sm rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
        >
          Clear all
        </button>
        <button
          type="button"
          onClick={onClose}
          className="min-h-[44px] flex-1 text-sm font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500"
        >
          {resultCount === 1 ? "Show 1 prospect" : `Show ${resultCount} prospects`}
        </button>
      </div>
    </Sheet>
  );
}
