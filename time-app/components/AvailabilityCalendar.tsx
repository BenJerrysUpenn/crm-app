"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Availability } from "@/lib/types";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function weekdayOf(dateStr: string) {
  return new Date(dateStr + "T12:00:00Z").getUTCDay();
}
function fmtT(t: string | null) {
  if (!t) return "all day";
  const [h, m] = t.split(":");
  const hr = Number(h);
  const ap = hr >= 12 ? "pm" : "am";
  const h12 = hr % 12 === 0 ? 12 : hr % 12;
  return m === "00" ? `${h12}${ap}` : `${h12}:${m}${ap}`;
}
function monthLabel(monthKey: string) {
  return new Date(monthKey + "-01T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
function addMonth(monthKey: string, n: number) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type Draft = {
  date: string;
  kind: "unavailable" | "preferred";
  allDay: boolean;
  start: string;
  end: string;
  repeats: boolean;
  note: string;
};

export default function AvailabilityCalendar({
  monthKey,
  gridStart,
  specific,
  recurring,
  timeOff,
  lockedDays,
  postedThrough,
  today,
}: {
  monthKey: string;
  gridStart: string;
  specific: Availability[];
  recurring: Availability[];
  timeOff: Availability[];
  lockedDays: string[];
  postedThrough: string | null;
  today: string;
}) {
  const router = useRouter();
  const lockedSet = new Set(lockedDays);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<Availability | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  function prefsFor(date: string) {
    const wd = weekdayOf(date);
    const s = specific.filter((a) => a.specific_date === date);
    const r = recurring.filter((a) => a.weekday === wd);
    const off = timeOff.filter((a) => a.specific_date === date);
    return { s, r, off };
  }

  // A day is locked if it's in the past, or on/before the latest posted day.
  function isLocked(date: string) {
    return date < today || (postedThrough !== null && date <= postedThrough);
  }

  function openAdd(date: string) {
    if (isLocked(date)) return;
    setErr(null);
    setDraft({ date, kind: "unavailable", allDay: false, start: "09:00", end: "17:00", repeats: false, note: "" });
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    const payload: Record<string, unknown> = {
      is_available: true,
      preference: draft.kind === "unavailable" ? "unavailable" : "preferred",
      start_time: draft.allDay ? null : draft.start + ":00",
      end_time: draft.allDay ? null : draft.end + ":00",
      note: draft.note || null,
      status: "approved",
    };
    if (draft.repeats) payload.weekday = weekdayOf(draft.date);
    else payload.specific_date = draft.date;

    const res = await fetch("/api/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!res.ok) {
      setErr((await res.json().catch(() => ({}))).error ?? "Save failed.");
      return;
    }
    setDraft(null);
    router.refresh();
  }

  async function del(id: number) {
    await fetch(`/api/availability/${id}`, { method: "DELETE" });
    router.refresh();
  }

  function gotoMonth(n: number) {
    router.push(`/availability?month=${addMonth(monthKey, n)}`);
  }

  function Chip({ a, recurringChip }: { a: Availability; recurringChip?: boolean }) {
    const unavail = a.preference === "unavailable";
    return (
      <button
        onClick={() => setViewing(a)}
        title="Click for details"
        className={`block w-full text-left truncate rounded px-1 py-0.5 text-[10px] mb-0.5 ${
          unavail
            ? "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300"
            : "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300"
        }`}
      >
        {recurringChip ? "↻ " : ""}{unavail ? "✕" : "★"} {fmtT(a.start_time)}{a.start_time ? `–${fmtT(a.end_time)}` : ""}
      </button>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mr-auto">My Availability</h1>
        <button onClick={() => gotoMonth(-1)} className="text-xs px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">‹</button>
        <span className="text-sm font-medium text-slate-800 dark:text-slate-200 min-w-[140px] text-center">{monthLabel(monthKey)}</span>
        <button onClick={() => gotoMonth(1)} className="text-xs px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">›</button>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Click a day to add a preference. <span className="text-rose-500">✕ unavailable</span>, <span className="text-sky-500">★ prefer to work</span>, ↻ repeats weekly. Tap a chip to see it or remove it. Posted days are locked.
      </p>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="grid grid-cols-7 bg-slate-100 dark:bg-slate-800/60 text-[11px] font-medium text-slate-500">
          {DOW.map((d) => <div key={d} className="px-2 py-1.5 text-center">{d}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {days.map((date) => {
            const inMonth = date.slice(0, 7) === monthKey;
            const past = date < today;
            const posted = lockedSet.has(date);
            const locked = isLocked(date);
            const { s, r, off } = prefsFor(date);
            return (
              <div
                key={date}
                onClick={() => openAdd(date)}
                className={`min-h-[92px] border-b border-r border-slate-200 dark:border-slate-800 p-1 ${
                  locked ? "cursor-not-allowed bg-slate-50 dark:bg-slate-950/40" : "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                } ${inMonth ? "" : "bg-slate-50/60 dark:bg-slate-950/40"}`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-[11px] ${date === today ? "bg-emerald-500 text-white rounded-full w-5 h-5 flex items-center justify-center" : past ? "text-slate-400 dark:text-slate-600" : inMonth ? "text-slate-700 dark:text-slate-300" : "text-slate-400 dark:text-slate-600"}`}>
                    {Number(date.slice(8, 10))}
                  </span>
                  {posted && <span className="text-[10px]">🔒</span>}
                </div>
                <div className="mt-1" onClick={(e) => e.stopPropagation()}>
                  {off.map((a) => (
                    <div key={a.id} className="truncate rounded px-1 py-0.5 text-[10px] mb-0.5 bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                      time off ({a.status})
                    </div>
                  ))}
                  {s.map((a) => <Chip key={a.id} a={a} />)}
                  {r.map((a) => <Chip key={"r" + a.id} a={a} recurringChip />)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {draft && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 px-4" onClick={() => setDraft(null)}>
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl p-5 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold text-slate-900 dark:text-slate-100">
              Add preference — {new Date(draft.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
            </h2>

            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                <input type="radio" checked={draft.kind === "unavailable"} onChange={() => setDraft({ ...draft, kind: "unavailable" })} /> I&apos;m unavailable to work
              </label>
              <label className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                <input type="radio" checked={draft.kind === "preferred"} onChange={() => setDraft({ ...draft, kind: "preferred" })} /> I prefer to work
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input type="checkbox" checked={draft.allDay} onChange={(e) => setDraft({ ...draft, allDay: e.target.checked })} /> All day
            </label>

            {!draft.allDay && (
              <div className="flex items-center gap-2">
                <input type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1.5 text-slate-900 dark:text-slate-100" />
                <span className="text-slate-500">–</span>
                <input type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1.5 text-slate-900 dark:text-slate-100" />
              </div>
            )}

            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input type="checkbox" checked={draft.repeats} onChange={(e) => setDraft({ ...draft, repeats: e.target.checked })} /> Repeats every {DOW[weekdayOf(draft.date)]}
            </label>

            <label className="block text-xs text-slate-600 dark:text-slate-400">Note
              <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1.5 text-slate-900 dark:text-slate-100" />
            </label>

            {err && <div className="text-sm text-rose-400">{err}</div>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setDraft(null)} className="px-3 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">Cancel</button>
              <button onClick={save} disabled={busy} className="px-3 py-1.5 text-sm rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {viewing && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 px-4" onClick={() => setViewing(null)}>
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl p-5 w-full max-w-sm space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold text-slate-900 dark:text-slate-100">
              {viewing.preference === "unavailable" ? "Unavailable to work" : "Prefer to work"}
            </h2>
            <div className="text-sm text-slate-700 dark:text-slate-300">
              {viewing.weekday !== null ? `Every ${DOW[viewing.weekday]}` : new Date((viewing.specific_date ?? "") + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
              {" · "}
              {viewing.start_time ? `${fmtT(viewing.start_time)}–${fmtT(viewing.end_time)}` : "all day"}
            </div>
            {viewing.note && <div className="text-sm text-slate-500">{viewing.note}</div>}
            <div className="flex justify-between pt-2">
              <button onClick={() => { del(viewing.id); setViewing(null); }} className="text-sm text-rose-500 hover:text-rose-400">Remove</button>
              <button onClick={() => setViewing(null)} className="px-3 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">Close</button>
            </div>
          </div>
        </div>
      )}

      <TimeOffSection timeOff={timeOff} />
    </div>
  );
}

function TimeOffSection({ timeOff }: { timeOff: Availability[] }) {
  const router = useRouter();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function fmtDate(d: string) {
    return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  function statusBadge(s: string) {
    if (s === "approved") return <span className="text-emerald-500">approved</span>;
    if (s === "denied") return <span className="text-rose-500">denied</span>;
    return <span className="text-amber-500">pending</span>;
  }
  const groups = (() => {
    const map = new Map<string, Availability[]>();
    for (const r of timeOff) {
      const k = r.request_group ?? `s${r.id}`;
      const arr = map.get(k) ?? [];
      arr.push(r);
      map.set(k, arr);
    }
    return Array.from(map.entries()).map(([k, arr]) => {
      const ds = arr.map((a) => a.specific_date!).sort();
      return { key: k, anyId: arr[0].id, start: ds[0], end: ds[ds.length - 1], status: arr[0].status, note: arr[0].note };
    }).sort((a, b) => (a.start < b.start ? -1 : 1));
  })();

  async function add() {
    if (!from) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_date: from, end_date: to || from, is_available: false, note: note || null, status: "pending" }),
    });
    setBusy(false);
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? "Request failed."); return; }
    setFrom(""); setTo(""); setNote("");
    router.refresh();
  }
  async function del(id: number) {
    await fetch(`/api/availability/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
      <div className="text-sm font-medium text-slate-700 dark:text-slate-300">Time-off requests</div>
      <p className="text-xs text-slate-500">A manager approves these. You can&apos;t request off once that day&apos;s schedule is posted.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600 dark:text-slate-400">From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ml-2 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1 text-slate-900 dark:text-slate-100" />
        </label>
        <label className="text-xs text-slate-600 dark:text-slate-400">To
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="ml-2 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1 text-slate-900 dark:text-slate-100" />
        </label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (optional)" className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1 text-slate-900 dark:text-slate-100 text-sm flex-1 min-w-[140px]" />
        <button onClick={add} disabled={busy || !from} className="text-sm px-3 py-1.5 rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium disabled:opacity-40">Request</button>
      </div>
      {err && <div className="text-sm text-rose-400">{err}</div>}
      {groups.length > 0 && (
        <div className="space-y-1 pt-1">
          {groups.map((g) => (
            <div key={g.key} className="flex items-center justify-between text-sm border-b border-slate-200 dark:border-slate-800 pb-1 last:border-0">
              <span className="text-slate-700 dark:text-slate-300">
                {g.start === g.end ? fmtDate(g.start) : `${fmtDate(g.start)} – ${fmtDate(g.end)}`} · {statusBadge(g.status)}{g.note ? ` · ${g.note}` : ""}
              </span>
              <button onClick={() => del(g.anyId)} className="text-slate-500 hover:text-rose-400 text-xs">{g.status === "pending" ? "Cancel" : "Delete"}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
