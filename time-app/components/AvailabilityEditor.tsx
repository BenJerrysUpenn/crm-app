"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtDate } from "@/lib/format";
import type { Availability } from "@/lib/types";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function t(s: string | null) {
  if (!s) return "any time";
  const [h, m] = s.split(":");
  const hr = Number(h);
  const ampm = hr >= 12 ? "pm" : "am";
  const h12 = hr % 12 === 0 ? 12 : hr % 12;
  return `${h12}:${m}${ampm}`;
}

export default function AvailabilityEditor({ initial }: { initial: Availability[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<"weekly" | "date">("weekly");
  const [weekday, setWeekday] = useState(1);
  const [date, setDate] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [isAvail, setIsAvail] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setErr(null);
    const payload =
      tab === "weekly"
        ? { weekday, start_time: start || null, end_time: end || null, is_available: isAvail, note: note || null }
        : { specific_date: date, start_time: start || null, end_time: end || null, is_available: isAvail, note: note || null };
    if (tab === "date" && !date) {
      setErr("Pick a date.");
      setBusy(false);
      return;
    }
    const res = await fetch("/api/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!res.ok) {
      setErr((await res.json().catch(() => ({}))).error ?? "Failed.");
      return;
    }
    setStart(""); setEnd(""); setNote(""); setDate("");
    router.refresh();
  }

  async function del(id: number) {
    await fetch(`/api/availability/${id}`, { method: "DELETE" });
    router.refresh();
  }

  const weekly = initial.filter((a) => a.weekday !== null);
  const dated = initial.filter((a) => a.specific_date !== null);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">My availability</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Tell managers when you can and can&apos;t work. Set recurring weekly windows, or block off specific dates for time off.
      </p>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
        <div className="flex gap-2">
          <button onClick={() => setTab("weekly")} className={`px-3 py-1 text-sm rounded-md ${tab === "weekly" ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700"}`}>Weekly</button>
          <button onClick={() => setTab("date")} className={`px-3 py-1 text-sm rounded-md ${tab === "date" ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700"}`}>Specific date</button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {tab === "weekly" ? (
            <label className="text-xs text-slate-600 dark:text-slate-400 col-span-2">Day
              <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100">
                {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </label>
          ) : (
            <label className="text-xs text-slate-600 dark:text-slate-400 col-span-2">Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100" />
            </label>
          )}
          <label className="text-xs text-slate-600 dark:text-slate-400">From
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100" />
          </label>
          <label className="text-xs text-slate-600 dark:text-slate-400">To
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100" />
          </label>
        </div>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input type="radio" checked={isAvail} onChange={() => setIsAvail(true)} /> Available
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input type="radio" checked={!isAvail} onChange={() => setIsAvail(false)} /> Unavailable / time off
          </label>
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100 text-sm" />
        {err && <div className="text-sm text-rose-300">{err}</div>}
        <button onClick={add} disabled={busy} className="px-3 py-1.5 text-sm rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-50">Add</button>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">Weekly</div>
        {weekly.length === 0 ? <div className="text-slate-500 text-sm">None set.</div> : (
          <div className="space-y-2">
            {weekly.map((a) => (
              <Row key={a.id} label={`${DAYS[a.weekday!]} · ${t(a.start_time)}–${t(a.end_time)}`} a={a} onDel={del} />
            ))}
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">Specific dates</div>
        {dated.length === 0 ? <div className="text-slate-500 text-sm">None set.</div> : (
          <div className="space-y-2">
            {dated.map((a) => (
              <Row key={a.id} label={`${fmtDate(a.specific_date! + "T12:00:00")} · ${t(a.start_time)}–${t(a.end_time)}`} a={a} onDel={del} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, a, onDel }: { label: string; a: Availability; onDel: (id: number) => void }) {
  return (
    <div className="flex items-center justify-between text-sm border-b border-slate-200 dark:border-slate-800 pb-2 last:border-0">
      <div>
        <span className={a.is_available ? "text-emerald-300" : "text-rose-300"}>{a.is_available ? "✓" : "✕"}</span>{" "}
        <span className="text-slate-700 dark:text-slate-300">{label}</span>
        {a.note && <span className="text-slate-500"> · {a.note}</span>}
      </div>
      <button onClick={() => onDel(a.id)} className="text-slate-500 hover:text-rose-400 text-xs">Remove</button>
    </div>
  );
}
