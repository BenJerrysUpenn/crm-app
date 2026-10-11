// The Team view's week grid: one row per person on the roster, one column per
// day. The cell model comes from lib/teamAvailability.ts; this only draws it.

import { formatDayLabel } from "@/lib/coverage";
import { cellTitle, summaryLine, type Cell, type TeamGrid } from "@/lib/teamAvailability";
import type { Kind } from "@/lib/availabilityCheck";

const LINE: Record<Kind, string> = {
  unavailable: "text-rose-700 dark:text-rose-300",
  available: "text-emerald-700 dark:text-emerald-300",
  preferred: "text-sky-700 dark:text-sky-300",
};

// Name column, then seven days that share the rest. The min width only bites
// below ~930px, where the grid scrolls sideways instead of squashing.
const COLS = "minmax(116px, 200px) repeat(7, minmax(104px, 1fr))";

// Diagonal hatching for a day the person can't work at all.
const HATCH = {
  backgroundImage:
    "repeating-linear-gradient(135deg, transparent 0 6px, rgb(var(--hatch) / 0.12) 6px 7px)",
} as const;

function CellBody({ cell }: { cell: Cell }) {
  switch (cell.state) {
    case "time_off":
      return cell.status === "approved" ? (
        <div className="rounded-md px-2 py-1 text-xs font-medium bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-200">
          Time off
        </div>
      ) : (
        <div className="rounded-md px-2 py-1 text-xs font-medium bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800">
          Time off pending
        </div>
      );
    case "unavailable":
      return (
        <div
          style={HATCH}
          className="rounded-md px-2 py-1 text-xs font-medium bg-slate-200 text-slate-700 [--hatch:15_23_42] dark:bg-slate-800 dark:text-slate-300 dark:[--hatch:241_245_249]"
        >
          Unavailable{cell.weekly ? <span className="text-slate-500 dark:text-slate-400"> ↻</span> : null}
        </div>
      );
    case "none":
      return <div className="text-[11px] italic text-slate-400 dark:text-slate-500">no availability</div>;
    case "blocks":
      return (
        <div className="space-y-0.5">
          {cell.lines.map((l, i) => (
            <div key={i} className={`text-xs font-medium leading-snug ${LINE[l.kind]}`}>
              {l.text}
              {l.weekly ? <span className="text-slate-400 dark:text-slate-500 font-normal"> ↻</span> : null}
            </div>
          ))}
        </div>
      );
  }
}

export default function TeamAvailabilityGrid({ grid, rangeLabel }: { grid: TeamGrid; rangeLabel: string }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="text-sm font-medium text-slate-800 dark:text-slate-200">{rangeLabel}</div>
        <div className="text-sm text-slate-600 dark:text-slate-400">{summaryLine(grid)}</div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 sm:ml-auto">↻ repeats every week</div>
      </div>

      {grid.rows.length === 0 ? (
        <div className="text-slate-500 text-sm">Nobody is on the roster.</div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-x-auto bg-white dark:bg-slate-900">
          <div role="table" aria-label="Team availability" className="min-w-[880px]">
            <div
              role="row"
              className="grid bg-slate-100 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800"
              style={{ gridTemplateColumns: COLS }}
            >
              <div role="columnheader" className="px-3 py-2 sticky left-0 z-10 bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                Staff
              </div>
              {grid.dates.map((d) => (
                <div role="columnheader" key={d} className="px-2 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 border-l border-slate-200 dark:border-slate-800">
                  {formatDayLabel(d)}
                </div>
              ))}
            </div>
            {grid.rows.map((r) => (
              <div
                role="row"
                key={r.id}
                className="grid border-b last:border-b-0 border-slate-200 dark:border-slate-800"
                style={{ gridTemplateColumns: COLS }}
              >
                <div role="rowheader" className="px-3 py-2 sticky left-0 z-10 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate" title={r.name}>{r.name}</div>
                  {!r.submitted && (
                    <div className="text-[11px] leading-tight text-amber-700 dark:text-amber-400">No availability submitted this week</div>
                  )}
                </div>
                {r.cells.map((c, i) => (
                  <div
                    role="cell"
                    key={c.date}
                    title={cellTitle(c)}
                    className={`px-2 py-2 min-h-[52px] ${i > 0 ? "border-l border-slate-200 dark:border-slate-800" : ""}`}
                  >
                    <CellBody cell={c} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
