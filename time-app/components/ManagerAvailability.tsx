"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtDate } from "@/lib/format";
import type { Availability, Profile } from "@/lib/types";

type Row = Availability & { profiles: Pick<Profile, "id" | "full_name"> };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function t(s: string | null) {
  if (!s) return "any";
  const [h, m] = s.split(":");
  const hr = Number(h);
  const ampm = hr >= 12 ? "pm" : "am";
  const h12 = hr % 12 === 0 ? 12 : hr % 12;
  return `${h12}:${m}${ampm}`;
}

export default function ManagerAvailability({
  weekStart,
  weekRows,
  timeOff,
}: {
  weekStart: string;
  weekRows: Row[];
  timeOff: Row[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);

  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const rangeLabel = `${fmtDate(dates[0] + "T12:00:00")} – ${fmtDate(dates[6] + "T12:00:00")}`;

  function gotoWeek(deltaDays: number) {
    router.push(`/availability?week=${addDays(weekStart, deltaDays)}`);
  }

  async function decide(id: number, status: "approved" | "denied") {
    setBusyId(id);
    await fetch(`/api/availability/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusyId(null);
    router.refresh();
  }

  // Group week availability by employee.
  const byEmp = new Map<string, Row[]>();
  for (const r of weekRows) {
    const arr = byEmp.get(r.employee_id) ?? [];
    arr.push(r);
    byEmp.set(r.employee_id, arr);
  }

  type TOGroup = {
    key: string;
    anyId: number;
    name: string;
    start: string;
    end: string;
    status: Row["status"];
    note: string | null;
  };
  function group(rows: Row[]): TOGroup[] {
    const map = new Map<string, Row[]>();
    for (const r of rows) {
      const key = `${r.employee_id}|${r.request_group ?? "single-" + r.id}`;
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    return Array.from(map.entries())
      .map(([key, arr]) => {
        const dates = arr.map((a) => a.specific_date!).sort();
        return {
          key,
          anyId: arr[0].id,
          name: arr[0].profiles?.full_name ?? arr[0].employee_id,
          start: dates[0],
          end: dates[dates.length - 1],
          status: arr[0].status,
          note: arr[0].note,
        };
      })
      .sort((a, b) => (a.start < b.start ? -1 : 1));
  }
  function groupRange(g: TOGroup) {
    return g.start === g.end
      ? fmtDate(g.start + "T12:00:00")
      : `${fmtDate(g.start + "T12:00:00")} – ${fmtDate(g.end + "T12:00:00")}`;
  }

  const pending = group(timeOff.filter((r) => r.status === "pending"));
  const decided = group(timeOff.filter((r) => r.status !== "pending"));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mr-auto">Team availability</h1>
        <button onClick={() => gotoWeek(-7)} className="text-xs px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">‹ Prev</button>
        <button onClick={() => router.push("/availability")} className="text-xs px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">This week</button>
        <button onClick={() => gotoWeek(7)} className="text-xs px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">Next ›</button>
      </div>

      {/* Time-off approvals */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">
          Time-off requests {pending.length > 0 && <span className="text-amber-400">({pending.length} pending)</span>}
        </div>
        {pending.length === 0 ? (
          <div className="text-slate-500 text-sm">No pending requests.</div>
        ) : (
          <div className="space-y-2">
            {pending.map((g) => (
              <div key={g.key} className="flex items-center justify-between gap-3 text-sm border-b border-slate-200 dark:border-slate-800 pb-2 last:border-0">
                <span className="text-slate-800 dark:text-slate-200">
                  {g.name} · {groupRange(g)}
                  {g.note ? ` · ${g.note}` : ""}
                </span>
                <span className="flex gap-2 shrink-0">
                  <button onClick={() => decide(g.anyId, "approved")} disabled={busyId === g.anyId} className="text-xs px-2 py-1 rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-50">Approve</button>
                  <button onClick={() => decide(g.anyId, "denied")} disabled={busyId === g.anyId} className="text-xs px-2 py-1 rounded-md border border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950">Deny</button>
                </span>
              </div>
            ))}
          </div>
        )}
        {decided.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 space-y-1">
            {decided.map((g) => (
              <div key={g.key} className="flex items-center justify-between text-xs text-slate-500">
                <span>{g.name} · {groupRange(g)}</span>
                <span className="flex items-center gap-2">
                  <span className={g.status === "approved" ? "text-emerald-400" : "text-rose-400"}>{g.status}</span>
                  <button onClick={() => decide(g.anyId, g.status === "approved" ? "denied" : "approved")} className="hover:text-slate-700 dark:hover:text-slate-300 underline">
                    {g.status === "approved" ? "deny" : "approve"}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Week availability per employee */}
      <div className="text-sm text-slate-600 dark:text-slate-400">{rangeLabel}</div>
      {byEmp.size === 0 ? (
        <div className="text-slate-500 text-sm">No availability submitted for this week.</div>
      ) : (
        Array.from(byEmp.entries()).map(([id, list]) => (
          <div key={id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
            <div className="text-sm font-medium text-slate-800 dark:text-slate-200 mb-3">{list[0].profiles?.full_name ?? id}</div>
            <div className="flex flex-wrap gap-2">
              {list
                .slice()
                .sort((a, b) => (a.specific_date! < b.specific_date! ? -1 : 1))
                .map((a) => {
                  const col = dates.indexOf(a.specific_date!);
                  const pref = a.preference ?? "available";
                  const cls =
                    pref === "unavailable"
                      ? "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900"
                      : pref === "preferred"
                        ? "bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:border-sky-900"
                        : "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900";
                  return (
                    <span key={a.id} className={`text-xs rounded-md px-2 py-1 border ${cls}`}>
                      {col >= 0 ? DOW[col] : fmtDate(a.specific_date! + "T12:00:00")} {t(a.start_time)}–{t(a.end_time)}
                    </span>
                  );
                })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
