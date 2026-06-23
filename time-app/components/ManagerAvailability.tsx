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

  const pending = timeOff.filter((r) => r.status === "pending");
  const decided = timeOff.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-100 mr-auto">Team availability</h1>
        <button onClick={() => gotoWeek(-7)} className="text-xs px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">‹ Prev</button>
        <button onClick={() => router.push("/availability")} className="text-xs px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">This week</button>
        <button onClick={() => gotoWeek(7)} className="text-xs px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">Next ›</button>
      </div>

      {/* Time-off approvals */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div className="text-sm font-medium text-slate-300 mb-3">
          Time-off requests {pending.length > 0 && <span className="text-amber-400">({pending.length} pending)</span>}
        </div>
        {pending.length === 0 ? (
          <div className="text-slate-500 text-sm">No pending requests.</div>
        ) : (
          <div className="space-y-2">
            {pending.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 text-sm border-b border-slate-800 pb-2 last:border-0">
                <span className="text-slate-200">
                  {r.profiles?.full_name ?? r.employee_id} · {fmtDate(r.specific_date! + "T12:00:00")}
                  {r.note ? ` · ${r.note}` : ""}
                </span>
                <span className="flex gap-2 shrink-0">
                  <button onClick={() => decide(r.id, "approved")} disabled={busyId === r.id} className="text-xs px-2 py-1 rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-50">Approve</button>
                  <button onClick={() => decide(r.id, "denied")} disabled={busyId === r.id} className="text-xs px-2 py-1 rounded-md border border-rose-800 text-rose-300 hover:bg-rose-950">Deny</button>
                </span>
              </div>
            ))}
          </div>
        )}
        {decided.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-800 space-y-1">
            {decided.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-xs text-slate-500">
                <span>{r.profiles?.full_name ?? r.employee_id} · {fmtDate(r.specific_date! + "T12:00:00")}</span>
                <span className="flex items-center gap-2">
                  <span className={r.status === "approved" ? "text-emerald-400" : "text-rose-400"}>{r.status}</span>
                  <button onClick={() => decide(r.id, r.status === "approved" ? "denied" : "approved")} className="hover:text-slate-300 underline">
                    {r.status === "approved" ? "deny" : "approve"}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Week availability per employee */}
      <div className="text-sm text-slate-400">{rangeLabel}</div>
      {byEmp.size === 0 ? (
        <div className="text-slate-500 text-sm">No availability submitted for this week.</div>
      ) : (
        Array.from(byEmp.entries()).map(([id, list]) => (
          <div key={id} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <div className="text-sm font-medium text-slate-200 mb-3">{list[0].profiles?.full_name ?? id}</div>
            <div className="flex flex-wrap gap-2">
              {list
                .slice()
                .sort((a, b) => (a.specific_date! < b.specific_date! ? -1 : 1))
                .map((a) => {
                  const col = dates.indexOf(a.specific_date!);
                  return (
                    <span key={a.id} className="text-xs rounded-md px-2 py-1 border bg-emerald-950/40 border-emerald-900 text-emerald-200">
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
