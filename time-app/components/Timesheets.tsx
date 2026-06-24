"use client";

import { useRouter } from "next/navigation";
import { fmtDate, fmtTime, hoursBetween } from "@/lib/format";
import type { Profile, TimeEntryWithEmployee } from "@/lib/types";

type Entry = TimeEntryWithEmployee & { shifts?: { starts_at: string } | null };

// Minutes late = clock-in minus scheduled shift start (only if positive and a
// shift is linked), beyond the configured grace.
function lateMinutes(e: Entry, graceMin: number): number {
  if (!e.shifts?.starts_at) return 0;
  const diff = (new Date(e.clock_in_at).getTime() - new Date(e.shifts.starts_at).getTime()) / 60000;
  return diff > graceMin ? Math.round(diff) : 0;
}

export default function Timesheets({
  isManager,
  from,
  to,
  emp,
  employees,
  entries,
  tardyGraceMin,
}: {
  isManager: boolean;
  from: string;
  to: string;
  emp: string;
  employees: Profile[];
  entries: Entry[];
  tardyGraceMin: number;
}) {
  const router = useRouter();

  function apply(next: { from?: string; to?: string; emp?: string }) {
    const params = new URLSearchParams({ from, to });
    if (emp) params.set("emp", emp);
    if (next.from !== undefined) params.set("from", next.from);
    if (next.to !== undefined) params.set("to", next.to);
    if (next.emp !== undefined) {
      if (next.emp) params.set("emp", next.emp);
      else params.delete("emp");
    }
    router.push(`/timesheets?${params.toString()}`);
  }

  // Totals by employee.
  const byEmp = new Map<string, { name: string; hours: number; rate: number | null }>();
  let grand = 0;
  for (const e of entries) {
    const h = hoursBetween(e.clock_in_at, e.clock_out_at);
    grand += h;
    const id = e.employee_id;
    const cur = byEmp.get(id) ?? {
      name: e.profiles?.full_name ?? id,
      hours: 0,
      rate: e.profiles?.hourly_rate ?? null,
    };
    cur.hours += h;
    byEmp.set(id, cur);
  }

  function exportCsv() {
    const rows = [
      ["Employee", "Date", "Clock in", "Clock out", "Hours", "Late (min)", "Status", "In distance (m)"],
      ...entries.map((e) => [
        e.profiles?.full_name ?? e.employee_id,
        fmtDate(e.clock_in_at),
        fmtTime(e.clock_in_at),
        fmtTime(e.clock_out_at),
        String(hoursBetween(e.clock_in_at, e.clock_out_at)),
        lateMinutes(e, tardyGraceMin) ? String(lateMinutes(e, tardyGraceMin)) : "",
        e.status,
        e.clock_in_distance_m != null ? String(e.clock_in_distance_m) : "",
      ]),
    ];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `timesheet_${from}_to_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-100 mb-3">Timesheets</h1>
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <label className="flex flex-col text-xs text-slate-400">From
          <input type="date" value={from} onChange={(e) => apply({ from: e.target.value })} className="mt-1 bg-slate-800 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100" />
        </label>
        <label className="flex flex-col text-xs text-slate-400">To
          <input type="date" value={to} onChange={(e) => apply({ to: e.target.value })} className="mt-1 bg-slate-800 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100" />
        </label>
        {isManager && (
          <label className="flex flex-col text-xs text-slate-400">Employee
            <select value={emp} onChange={(e) => apply({ emp: e.target.value })} className="mt-1 bg-slate-800 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
              <option value="">All</option>
              {employees.map((x) => <option key={x.id} value={x.id}>{x.full_name ?? x.id}</option>)}
            </select>
          </label>
        )}
        <button onClick={exportCsv} className="ml-auto px-3 py-2 text-sm rounded-md bg-slate-100 text-slate-900 font-medium hover:bg-white">Export CSV</button>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 mb-5">
        <div className="text-sm font-medium text-slate-300 mb-3">Totals</div>
        <div className="space-y-1">
          {Array.from(byEmp.entries()).map(([id, v]) => (
            <div key={id} className="flex justify-between text-sm">
              <span className="text-slate-300">{v.name}</span>
              <span className="text-slate-400">
                {v.hours.toFixed(2)} h{v.rate ? ` · $${(v.hours * v.rate).toFixed(2)}` : ""}
              </span>
            </div>
          ))}
          <div className="flex justify-between text-sm font-semibold border-t border-slate-800 pt-2 mt-2">
            <span className="text-slate-200">Total</span>
            <span className="text-slate-100">{grand.toFixed(2)} h</span>
          </div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/60 text-slate-400 text-xs">
            <tr>
              {isManager && <th className="text-left px-3 py-2">Employee</th>}
              <th className="text-left px-3 py-2">Date</th>
              <th className="text-left px-3 py-2">In</th>
              <th className="text-left px-3 py-2">Out</th>
              <th className="text-right px-3 py-2">Hours</th>
              <th className="text-right px-3 py-2">Late</th>
              <th className="text-right px-3 py-2">Dist</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No entries in this range.</td></tr>
            ) : entries.map((e) => {
              const late = lateMinutes(e, tardyGraceMin);
              return (
              <tr key={e.id} className="border-t border-slate-800">
                {isManager && <td className="px-3 py-2 text-slate-300">{e.profiles?.full_name ?? "—"}</td>}
                <td className="px-3 py-2 text-slate-300">{fmtDate(e.clock_in_at)}</td>
                <td className="px-3 py-2 text-slate-400">{fmtTime(e.clock_in_at)}</td>
                <td className="px-3 py-2 text-slate-400">{e.clock_out_at ? fmtTime(e.clock_out_at) : <span className="text-emerald-400">open</span>}</td>
                <td className="px-3 py-2 text-right text-slate-300">{e.clock_out_at ? hoursBetween(e.clock_in_at, e.clock_out_at).toFixed(2) : "—"}</td>
                <td className="px-3 py-2 text-right">{late ? <span className="text-amber-400">{late}m</span> : <span className="text-slate-600">—</span>}</td>
                <td className="px-3 py-2 text-right text-slate-500">{e.clock_in_distance_m != null ? `${e.clock_in_distance_m}m` : "—"}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
