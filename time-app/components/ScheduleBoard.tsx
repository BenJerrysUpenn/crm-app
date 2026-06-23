"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtTime } from "@/lib/format";
import type { Profile, ShiftWithEmployee, Location } from "@/lib/types";

const TZ = "America/New_York";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabel(d: Date) {
  return d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
}
// Build a datetime-local value (local wall time) from a date + "HH:MM".
function toLocalInput(d: Date, hhmm: string) {
  const [h, m] = hhmm.split(":");
  const x = new Date(d);
  x.setHours(Number(h), Number(m), 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

type Draft = {
  id?: number;
  employee_id: string;
  location_id: string;
  starts_at: string;
  ends_at: string;
  position: string;
  notes: string;
  published: boolean;
};

export default function ScheduleBoard({
  isManager,
  weekStartISO,
  shifts,
  employees,
  locations,
}: {
  isManager: boolean;
  weekStartISO: string;
  shifts: ShiftWithEmployee[];
  employees: Profile[];
  locations: Location[];
}) {
  const router = useRouter();
  const weekStart = new Date(weekStartISO);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  function shiftsForDay(d: Date) {
    const key = d.toLocaleDateString("en-CA", { timeZone: TZ });
    return shifts.filter(
      (s) => new Date(s.starts_at).toLocaleDateString("en-CA", { timeZone: TZ }) === key,
    );
  }

  function gotoWeek(deltaDays: number) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + deltaDays);
    router.push(`/schedule?week=${d.toISOString()}`);
  }

  function newShift(d: Date) {
    setErr(null);
    setDraft({
      employee_id: employees[0]?.id ?? "",
      location_id: String(locations.find((l) => l.is_default)?.id ?? locations[0]?.id ?? ""),
      starts_at: toLocalInput(d, "09:00"),
      ends_at: toLocalInput(d, "17:00"),
      position: "",
      notes: "",
      published: false,
    });
  }

  function editShift(s: ShiftWithEmployee) {
    setErr(null);
    setDraft({
      id: s.id,
      employee_id: s.employee_id,
      location_id: String(s.location_id ?? ""),
      starts_at: s.starts_at.slice(0, 16),
      ends_at: s.ends_at.slice(0, 16),
      position: s.position ?? "",
      notes: s.notes ?? "",
      published: s.published,
    });
  }

  async function save(publish: boolean) {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    const payload = {
      employee_id: draft.employee_id,
      location_id: draft.location_id ? Number(draft.location_id) : null,
      starts_at: new Date(draft.starts_at).toISOString(),
      ends_at: new Date(draft.ends_at).toISOString(),
      position: draft.position || null,
      notes: draft.notes || null,
      published: publish || draft.published,
    };
    const url = draft.id ? `/api/shifts/${draft.id}` : "/api/shifts";
    const res = await fetch(url, {
      method: draft.id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "Save failed.");
      return;
    }
    setDraft(null);
    router.refresh();
  }

  async function remove() {
    if (!draft?.id) return;
    setBusy(true);
    await fetch(`/api/shifts/${draft.id}`, { method: "DELETE" });
    setBusy(false);
    setDraft(null);
    router.refresh();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold text-slate-100">Schedule</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => gotoWeek(-7)} className="px-2 py-1 text-sm rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">‹ Prev</button>
          <button onClick={() => router.push("/schedule")} className="px-2 py-1 text-sm rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">This week</button>
          <button onClick={() => gotoWeek(7)} className="px-2 py-1 text-sm rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">Next ›</button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3">
        {days.map((d, i) => (
          <div key={i} className="bg-slate-900 border border-slate-800 rounded-lg p-3 min-h-[120px]">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-slate-400">
                {DAYS[d.getDay()]} {dayLabel(d)}
              </div>
              {isManager && (
                <button onClick={() => newShift(d)} className="text-slate-400 hover:text-emerald-400 text-lg leading-none">+</button>
              )}
            </div>
            <div className="space-y-2">
              {shiftsForDay(d).map((s) => (
                <button
                  key={s.id}
                  onClick={() => isManager && editShift(s)}
                  className={`w-full text-left rounded-md px-2 py-1.5 text-xs border ${
                    s.published
                      ? "bg-emerald-950/40 border-emerald-900 text-emerald-200"
                      : "bg-slate-800 border-slate-700 text-slate-300"
                  }`}
                >
                  <div className="font-medium">{fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}</div>
                  {isManager && <div className="text-slate-400">{s.profiles?.full_name ?? "—"}</div>}
                  {s.position && <div className="text-slate-500">{s.position}</div>}
                  {!s.published && <div className="text-amber-400 mt-0.5">draft</div>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {draft && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 px-4" onClick={() => setDraft(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold text-slate-100">{draft.id ? "Edit shift" : "New shift"}</h2>
            <label className="block text-xs text-slate-400">Employee
              <select value={draft.employee_id} onChange={(e) => setDraft({ ...draft, employee_id: e.target.value })} className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-md px-2 py-2 text-slate-100">
                {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name ?? e.id}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs text-slate-400">Start
                <input type="datetime-local" value={draft.starts_at} onChange={(e) => setDraft({ ...draft, starts_at: e.target.value })} className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-md px-2 py-2 text-slate-100" />
              </label>
              <label className="block text-xs text-slate-400">End
                <input type="datetime-local" value={draft.ends_at} onChange={(e) => setDraft({ ...draft, ends_at: e.target.value })} className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-md px-2 py-2 text-slate-100" />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs text-slate-400">Position
                <input value={draft.position} onChange={(e) => setDraft({ ...draft, position: e.target.value })} className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-md px-2 py-2 text-slate-100" placeholder="Scooper" />
              </label>
              <label className="block text-xs text-slate-400">Location
                <select value={draft.location_id} onChange={(e) => setDraft({ ...draft, location_id: e.target.value })} className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-md px-2 py-2 text-slate-100">
                  <option value="">—</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-xs text-slate-400">Notes
              <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-md px-2 py-2 text-slate-100" />
            </label>
            {err && <div className="text-sm text-rose-300">{err}</div>}
            <div className="flex items-center justify-between pt-2">
              {draft.id ? (
                <button onClick={remove} disabled={busy} className="text-sm text-rose-400 hover:text-rose-300">Delete</button>
              ) : <span />}
              <div className="flex gap-2">
                <button onClick={() => save(false)} disabled={busy} className="px-3 py-1.5 text-sm rounded-md border border-slate-600 text-slate-200 hover:bg-slate-800">Save draft</button>
                <button onClick={() => save(true)} disabled={busy} className="px-3 py-1.5 text-sm rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400">Publish</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
