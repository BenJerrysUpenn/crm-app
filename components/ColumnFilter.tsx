"use client";

import { useEffect, useRef, useState } from "react";
import { STAGES, STAGE_COLOURS, type Stage } from "@/lib/stages";

export default function ColumnFilter({
  visible,
  onChange,
}: {
  visible: ReadonlySet<Stage>;
  onChange: (next: Stage[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  function toggle(stage: Stage) {
    const next = new Set(visible);
    if (next.has(stage)) next.delete(stage);
    else next.add(stage);
    onChange(STAGES.filter((s) => next.has(s)));
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md px-3 py-1.5 border border-slate-700 inline-flex items-center gap-2"
      >
        <span>Columns</span>
        <span className="text-xs text-slate-400">
          {visible.size}/{STAGES.length}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-64 bg-slate-900 border border-slate-700 rounded-md shadow-xl z-30 p-1">
          {STAGES.map((stage) => {
            const checked = visible.has(stage);
            const colour = STAGE_COLOURS[stage];
            return (
              <button
                key={stage}
                type="button"
                onClick={() => toggle(stage)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-slate-800 text-left"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  readOnly
                  className="accent-slate-400"
                />
                <span className={`w-2 h-2 rounded-full ${colour.dot}`} />
                <span className="text-sm text-slate-200 flex-1">{stage}</span>
              </button>
            );
          })}
          <div className="border-t border-slate-800 mt-1 pt-1 flex gap-1">
            <button
              type="button"
              onClick={() => onChange([...STAGES])}
              className="flex-1 text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded hover:bg-slate-800"
            >
              All
            </button>
            <button
              type="button"
              onClick={() =>
                onChange([
                  "Open",
                  "Quote Review",
                  "Sent Quote",
                  "Booked Unpaid",
                  "Booked Paid",
                ])
              }
              className="flex-1 text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded hover:bg-slate-800"
            >
              Working pipeline
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
