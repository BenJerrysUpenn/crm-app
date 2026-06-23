"use client";

import { useState } from "react";
import { fmtDate } from "@/lib/format";
import type { Availability, Profile } from "@/lib/types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function t(s: string | null) {
  if (!s) return "any";
  const [h, m] = s.split(":");
  const hr = Number(h);
  const ampm = hr >= 12 ? "pm" : "am";
  const h12 = hr % 12 === 0 ? 12 : hr % 12;
  return `${h12}:${m}${ampm}`;
}

export default function ManagerAvailability({
  rows,
  employees,
}: {
  rows: (Availability & { profiles: Pick<Profile, "id" | "full_name"> })[];
  employees: Profile[];
}) {
  const [emp, setEmp] = useState("");
  const filtered = emp ? rows.filter((r) => r.employee_id === emp) : rows;

  const byEmp = new Map<string, typeof filtered>();
  for (const r of filtered) {
    const arr = byEmp.get(r.employee_id) ?? [];
    arr.push(r);
    byEmp.set(r.employee_id, arr);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-slate-100 mr-auto">Team availability</h1>
        <select value={emp} onChange={(e) => setEmp(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-slate-100 text-sm">
          <option value="">All employees</option>
          {employees.map((x) => <option key={x.id} value={x.id}>{x.full_name ?? x.id}</option>)}
        </select>
      </div>

      {byEmp.size === 0 ? (
        <div className="text-slate-500 text-sm">No availability submitted yet.</div>
      ) : (
        Array.from(byEmp.entries()).map(([id, list]) => (
          <div key={id} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <div className="text-sm font-medium text-slate-200 mb-3">{list[0].profiles?.full_name ?? id}</div>
            <div className="flex flex-wrap gap-2">
              {list.map((a) => (
                <span key={a.id} className={`text-xs rounded-md px-2 py-1 border ${a.is_available ? "bg-emerald-950/40 border-emerald-900 text-emerald-200" : "bg-rose-950/40 border-rose-900 text-rose-200"}`}>
                  {a.weekday !== null ? DAYS[a.weekday] : fmtDate(a.specific_date! + "T12:00:00")} {t(a.start_time)}–{t(a.end_time)}
                  {a.note ? ` (${a.note})` : ""}
                </span>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
