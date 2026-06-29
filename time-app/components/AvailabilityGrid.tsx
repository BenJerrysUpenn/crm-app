"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtDate } from "@/lib/format";
import type { Availability } from "@/lib/types";

const START_HOUR = 0;
const END_HOUR = 24;
const SLOT_MIN = 30;
const SLOTS = ((END_HOUR - START_HOUR) * 60) / SLOT_MIN;

type Pref = "available" | "preferred" | "unavailable";
const PREF_COLOR: Record<Pref, string> = {
  available: "bg-emerald-500/70",
  preferred: "bg-sky-500/70",
  unavailable: "bg-rose-500/60",
};
const PREF_LABEL: Record<Pref, string> = {
  available: "Available",
  preferred: "Preferred",
  unavailable: "Can't work",
};

function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function slotToMinutes(slot: number) {
  return START_HOUR * 60 + slot * SLOT_MIN;
}
function minutesToTime(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:00`;
}
function timeToMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function label(min: number) {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h24 >= 12 && h24 < 24 ? "pm" : "am";
  let h = h24 % 12;
  if (h === 0) h = 12;
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, "0")}${ampm}`;
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const key = (col: number, slot: number) => `${col}_${slot}`;

export default function AvailabilityGrid({
  weekStart,
  weekRows,
  timeOff,
  lockedDays,
}: {
  weekStart: string;
  weekRows: Availability[];
  timeOff: Availability[];
  lockedDays: string[];
}) {
  const router = useRouter();
  const dates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const lockedSet = useMemo(() => new Set(lockedDays), [lockedDays]);

  const seed = useMemo(() => {
    const m = new Map<string, Pref>();
    for (const a of weekRows) {
      if (!a.specific_date || !a.is_available || !a.start_time || !a.end_time) continue;
      const col = dates.indexOf(a.specific_date);
      if (col < 0) continue;
      const pref = (a.preference as Pref) ?? "available";
      const start = timeToMinutes(a.start_time);
      const end = timeToMinutes(a.end_time);
      for (let slot = 0; slot < SLOTS; slot++) {
        const mn = slotToMinutes(slot);
        if (mn >= start && mn < end) m.set(key(col, slot), pref);
      }
    }
    return m;
  }, [weekRows, dates]);

  const [cells, setCells] = useState<Map<string, Pref>>(seed);
  const [mode, setMode] = useState<Pref | "erase">("available");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setCells(seed);
    setDirty(false);
  }, [seed]);

  const painting = useRef(false);
  useEffect(() => {
    const up = () => (painting.current = false);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  function apply(col: number, slot: number) {
    if (lockedSet.has(dates[col])) return;
    setCells((prev) => {
      const k = key(col, slot);
      const next = new Map(prev);
      if (mode === "erase") next.delete(k);
      else next.set(k, mode);
      return next;
    });
    setDirty(true);
    setMsg(null);
  }
  function cellFromPoint(x: number, y: number) {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const cell = el?.closest("[data-col]") as HTMLElement | null;
    if (!cell) return null;
    return { col: Number(cell.dataset.col), slot: Number(cell.dataset.slot) };
  }
  function onPointerDown(e: React.PointerEvent, col: number, slot: number) {
    e.preventDefault();
    painting.current = true;
    apply(col, slot);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!painting.current) return;
    const c = cellFromPoint(e.clientX, e.clientY);
    if (c && !Number.isNaN(c.col) && !Number.isNaN(c.slot)) apply(c.col, c.slot);
  }

  function clearCol(col: number) {
    if (lockedSet.has(dates[col])) return;
    setCells((prev) => {
      const next = new Map(prev);
      for (let s = 0; s < SLOTS; s++) next.delete(key(col, s));
      return next;
    });
    setDirty(true);
  }

  function buildBlocks() {
    const blocks: { date: string; start_time: string; end_time: string; preference: Pref }[] = [];
    for (let col = 0; col < 7; col++) {
      let runStart: number | null = null;
      let runPref: Pref | null = null;
      for (let slot = 0; slot <= SLOTS; slot++) {
        const cur = slot < SLOTS ? cells.get(key(col, slot)) ?? null : null;
        if (cur !== runPref) {
          if (runPref !== null && runStart !== null) {
            blocks.push({
              date: dates[col],
              start_time: minutesToTime(slotToMinutes(runStart)),
              end_time: minutesToTime(slotToMinutes(slot)),
              preference: runPref,
            });
          }
          runStart = cur ? slot : null;
          runPref = cur;
        }
      }
    }
    return blocks;
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    const res = await fetch("/api/availability/week", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekStart, blocks: buildBlocks() }),
    });
    setSaving(false);
    if (!res.ok) {
      setMsg((await res.json().catch(() => ({}))).error ?? "Save failed.");
      return;
    }
    setDirty(false);
    setMsg("Saved.");
    router.refresh();
  }
  async function copyLastWeek() {
    setMsg(null);
    const res = await fetch("/api/availability/copy-week", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekStart }),
    });
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? (j.copied ? `Copied ${j.copied} blocks from last week.` : "Nothing to copy.") : (j.error ?? "Copy failed."));
    router.refresh();
  }
  function gotoWeek(deltaDays: number) {
    router.push(`/availability?week=${addDays(weekStart, deltaDays)}`);
  }

  const rangeLabel = `${fmtDate(dates[0] + "T12:00:00")} – ${fmtDate(dates[6] + "T12:00:00")}`;
  const modes: (Pref | "erase")[] = ["available", "preferred", "unavailable", "erase"];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-100 mr-auto">My Availability</h1>
        <button onClick={() => gotoWeek(-7)} className="text-xs px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">‹ Prev</button>
        <button onClick={() => router.push("/availability")} className="text-xs px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">This week</button>
        <button onClick={() => gotoWeek(7)} className="text-xs px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">Next ›</button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm text-slate-300 mr-auto">{rangeLabel}</div>
        <button onClick={copyLastWeek} className="text-xs px-2 py-1 rounded-md border border-slate-600 text-slate-200 hover:bg-slate-800">Copy last week</button>
        <button onClick={save} disabled={saving || !dirty} className="text-sm px-3 py-1.5 rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-40">
          {saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>

      {/* Paint mode selector */}
      <div className="flex flex-wrap gap-2">
        {modes.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`text-xs px-2.5 py-1 rounded-md border flex items-center gap-1.5 ${
              mode === m ? "border-slate-300 bg-slate-800 text-slate-100" : "border-slate-700 text-slate-400 hover:bg-slate-800"
            }`}
          >
            {m !== "erase" && <span className={`inline-block w-2.5 h-2.5 rounded-sm ${PREF_COLOR[m]}`} />}
            {m === "erase" ? "Erase" : PREF_LABEL[m]}
          </button>
        ))}
      </div>
      <p className="text-sm text-slate-400">Pick a mode, then click and drag to paint the hours. Days already scheduled are locked.</p>
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 overflow-x-auto">
        <div className="select-none" style={{ touchAction: "none", minWidth: 560 }} onPointerMove={onPointerMove}>
          <div className="grid" style={{ gridTemplateColumns: `48px repeat(7, 1fr)` }}>
            <div />
            {dates.map((d, i) => {
              const locked = lockedSet.has(d);
              return (
                <button key={i} onClick={() => clearCol(i)} disabled={locked} className={`text-xs font-medium pb-1 ${locked ? "text-slate-600" : "text-slate-400 hover:text-slate-200"}`}>
                  {DOW[i]} {Number(d.slice(8, 10))}{locked ? " 🔒" : ""}
                </button>
              );
            })}
          </div>
          <div className="grid" style={{ gridTemplateColumns: `48px repeat(7, 1fr)` }}>
            {Array.from({ length: SLOTS }).map((_, slot) => {
              const min = slotToMinutes(slot);
              const onHour = min % 60 === 0;
              return (
                <FragmentRow key={slot}>
                  <div className={`text-[10px] text-slate-500 text-right pr-1 h-5 -mt-2 ${onHour ? "" : "opacity-0"}`}>
                    {onHour ? label(min) : ""}
                  </div>
                  {dates.map((d, col) => {
                    const locked = lockedSet.has(d);
                    const pref = cells.get(key(col, slot));
                    return (
                      <div
                        key={col}
                        data-col={col}
                        data-slot={slot}
                        onPointerDown={(e) => !locked && onPointerDown(e, col, slot)}
                        className={`h-5 border-b border-l border-slate-800 ${onHour ? "border-t border-t-slate-700/60" : ""} ${
                          locked ? "bg-slate-950/60 cursor-not-allowed" : "cursor-pointer hover:bg-slate-800/60"
                        } ${pref ? PREF_COLOR[pref] : ""}`}
                      />
                    );
                  })}
                </FragmentRow>
              );
            })}
          </div>
        </div>
      </div>

      <TimeOff timeOff={timeOff} />
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function statusBadge(s: string) {
  if (s === "approved") return <span className="text-emerald-400">approved</span>;
  if (s === "denied") return <span className="text-rose-400">denied</span>;
  return <span className="text-amber-400">pending</span>;
}

type TimeOffGroup = { key: string; anyId: number; start: string; end: string; status: Availability["status"]; note: string | null };
function groupTimeOff(rows: Availability[]): TimeOffGroup[] {
  const map = new Map<string, Availability[]>();
  for (const r of rows) {
    const k = r.request_group ?? `single-${r.id}`;
    const arr = map.get(k) ?? [];
    arr.push(r);
    map.set(k, arr);
  }
  return Array.from(map.entries())
    .map(([k, arr]) => {
      const ds = arr.map((a) => a.specific_date!).sort();
      return { key: k, anyId: arr[0].id, start: ds[0], end: ds[ds.length - 1], status: arr[0].status, note: arr[0].note };
    })
    .sort((a, b) => (a.start < b.start ? -1 : 1));
}

function TimeOff({ timeOff }: { timeOff: Availability[] }) {
  const router = useRouter();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    if (!res.ok) {
      setErr((await res.json().catch(() => ({}))).error ?? "Request failed.");
      return;
    }
    setFrom(""); setTo(""); setNote("");
    router.refresh();
  }
  async function del(id: number) {
    await fetch(`/api/availability/${id}`, { method: "DELETE" });
    router.refresh();
  }
  const groups = groupTimeOff(timeOff);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
      <div className="text-sm font-medium text-slate-300">Time-off requests</div>
      <p className="text-xs text-slate-500">Request a single day or a range. You can't request off once that day's schedule is posted.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-400">From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ml-2 bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-slate-100" />
        </label>
        <label className="text-xs text-slate-400">To
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="ml-2 bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-slate-100" />
        </label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (optional)" className="bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-slate-100 text-sm flex-1 min-w-[140px]" />
        <button onClick={add} disabled={busy || !from} className="text-sm px-3 py-1.5 rounded-md bg-slate-100 text-slate-900 font-medium hover:bg-white disabled:opacity-40">Request</button>
      </div>
      {err && <div className="text-sm text-rose-300">{err}</div>}
      {groups.length > 0 && (
        <div className="space-y-1 pt-1">
          {groups.map((g) => (
            <div key={g.key} className="flex items-center justify-between text-sm border-b border-slate-800 pb-1 last:border-0">
              <span className="text-slate-300">
                {g.start === g.end ? fmtDate(g.start + "T12:00:00") : `${fmtDate(g.start + "T12:00:00")} – ${fmtDate(g.end + "T12:00:00")}`} · {statusBadge(g.status)}
                {g.note ? ` · ${g.note}` : ""}
              </span>
              <button onClick={() => del(g.anyId)} className="text-slate-500 hover:text-rose-400 text-xs">{g.status === "pending" ? "Cancel" : "Delete"}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
