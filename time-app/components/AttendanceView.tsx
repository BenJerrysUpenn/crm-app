"use client";

import { useEffect, useState } from "react";
import { fmtDate, fmtTime } from "@/lib/format";

export type Notice = {
  id: string;
  name: string;
  kind: "late_in" | "out_late" | "out_early" | "no_show";
  minutes: number;
  atISO: string;
  position: string | null;
};

const LABEL: Record<Notice["kind"], string> = {
  late_in: "Clocked In Late",
  out_late: "Clocked Out Late",
  out_early: "Clocked Out Early",
  no_show: "No Show",
};

function dur(min: number) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const STORAGE_KEY = "bj_attendance_dismissed";

export default function AttendanceView({ notices }: { notices: Notice[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setDismissed(new Set(JSON.parse(raw)));
    } catch {}
  }, []);

  function persist(next: Set<string>) {
    setDismissed(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next)));
    } catch {}
  }
  function dismiss(id: string) {
    const next = new Set(dismissed);
    next.add(id);
    persist(next);
  }
  function clearAll() {
    const next = new Set(dismissed);
    visible.forEach((n) => next.add(n.id));
    persist(next);
  }

  const visible = notices.filter((n) => !dismissed.has(n.id));

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold text-slate-100">Attendance notices</h1>
        {visible.length > 0 && (
          <button onClick={clearAll} className="text-xs px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">
            Clear all
          </button>
        )}
      </div>
      <p className="text-sm text-slate-400 mb-4">Last 7 days · late or missed clock-ins vs the schedule.</p>

      {visible.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-center text-slate-500 text-sm">
          No attendance issues. Everyone's on time.
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl divide-y divide-slate-800">
          {visible.map((n) => (
            <div key={n.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="text-sm">
                  <span className={n.kind === "no_show" ? "text-rose-400 font-medium" : "text-amber-300 font-medium"}>
                    {LABEL[n.kind]}
                  </span>
                  {n.kind !== "no_show" && <span className="text-rose-400"> ({dur(n.minutes)})</span>}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {n.name} · {fmtDate(n.atISO)} at {fmtTime(n.atISO)}
                  {n.position ? ` · ${n.position}` : ""}
                </div>
              </div>
              <button onClick={() => dismiss(n.id)} className="text-slate-500 hover:text-slate-300 text-xs shrink-0">
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
