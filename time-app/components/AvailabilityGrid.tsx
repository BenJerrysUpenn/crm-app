"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtDate } from "@/lib/format";
import type { Availability } from "@/lib/types";

// Grid covers START_HOUR:00 to END_HOUR:00 in 30-minute slots.
const START_HOUR = 8;
const END_HOUR = 24;
const SLOT_MIN = 30;
const SLOTS = ((END_HOUR - START_HOUR) * 60) / SLOT_MIN;

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
}: {
  weekStart: string;
  weekRows: Availability[];
  timeOff: Availability[];
}) {
  const router = useRouter();

  // The 7 dates of this week as YYYY-MM-DD.
  const dates = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const seed = useMemo(() => {
    const s = new Set<string>();
    for (const a of weekRows) {
      if (!a.specific_date || !a.is_available || !a.start_time || !a.end_time) continue;
      const col = dates.indexOf(a.specific_date);
      if (col < 0) continue;
      const start = timeToMinutes(a.start_time);
      const end = timeToMinutes(a.end_time);
      for (let slot = 0; slot < SLOTS; slot++) {
        const m = slotToMinutes(slot);
        if (m >= start && m < end) s.add(key(col, slot));
      }
    }
    return s;
  }, [weekRows, dates]);

  const [selected, setSelected] = useState<Set<string>>(seed);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Re-seed when the week (and thus its data) changes.
  useEffect(() => {
    setSelected(seed);
    setDirty(false);
  }, [seed]);

  const painting = useRef(false);
  const paintValue = useRef(true);
  useEffect(() => {
    const up = () => (painting.current = false);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  function apply(col: number, slot: number, value: boolean) {
    setSelected((prev) => {
      const k = key(col, slot);
      if (prev.has(k) === value) return prev;
      const next = new Set(prev);
      if (value) next.add(k);
      else next.delete(k);
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
    paintValue.current = !selected.has(key(col, slot));
    apply(col, slot, paintValue.current);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!painting.current) return;
    const c = cellFromPoint(e.clientX, e.clientY);
    if (c && !Number.isNaN(c.col) && !Number.isNaN(c.slot))
      apply(c.col, c.slot, paintValue.current);
  }

  function clearCol(col: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (let s = 0; s < SLOTS; s++) next.delete(key(col, s));
      return next;
    });
    setDirty(true);
  }
  function clearAll() {
    setSelected(new Set());
    setDirty(true);
  }

  function buildBlocks() {
    const blocks: { date: string; start_time: string; end_time: string }[] = [];
    for (let col = 0; col < 7; col++) {
      let runStart: number | null = null;
      for (let slot = 0; slot <= SLOTS; slot++) {
        const on = slot < SLOTS && selected.has(key(col, slot));
        if (on && runStart === null) runStart = slot;
        if (!on && runStart !== null) {
          blocks.push({
            date: dates[col],
            start_time: minutesToTime(slotToMinutes(runStart)),
            end_time: minutesToTime(slotToMinutes(slot)),
          });
          runStart = null;
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
    setCopying(true);
    setMsg(null);
    const res = await fetch("/api/availability/copy-week", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekStart }),
    });
    setCopying(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(j.error ?? "Copy failed.");
      return;
    }
    setMsg(j.copied ? `Copied ${j.copied} blocks from last week.` : "Nothing to copy from last week.");
    router.refresh();
  }

  function gotoWeek(deltaDays: number) {
    router.push(`/availability?week=${addDays(weekStart, deltaDays)}`);
  }

  const rangeLabel = `${fmtDate(dates[0] + "T12:00:00")} – ${fmtDate(dates[6] + "T12:00:00")}`;

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
        <button onClick={copyLastWeek} disabled={copying} className="text-xs px-2 py-1 rounded-md border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-50">
          {copying ? "Copying…" : "Copy last week"}
        </button>
        <button onClick={clearAll} className="text-xs px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">Clear all</button>
        <button onClick={save} disabled={saving || !dirty} className="text-sm px-3 py-1.5 rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-40">
          {saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>
      <p className="text-sm text-slate-400">Click and drag to paint the hours you can work this week. Drag over green to erase.</p>
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 overflow-x-auto">
        <div className="select-none" style={{ touchAction: "none", minWidth: 560 }} onPointerMove={onPointerMove}>
          <div className="grid" style={{ gridTemplateColumns: `48px repeat(7, 1fr)` }}>
            <div />
            {dates.map((d, i) => (
              <button key={i} onClick={() => clearCol(i)} title="Click to clear this day" className="text-xs font-medium text-slate-400 pb-1 hover:text-slate-200">
                {DOW[i]} {Number(d.slice(8, 10))}
              </button>
            ))}
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
                  {dates.map((_, col) => {
                    const on = selected.has(key(col, slot));
                    return (
                      <div
                        key={col}
                        data-col={col}
                        data-slot={slot}
                        onPointerDown={(e) => onPointerDown(e, col, slot)}
                        className={`h-5 border-b border-l border-slate-800 cursor-pointer ${
                          on ? "bg-emerald-500/70" : "bg-transparent hover:bg-slate-800/60"
                        } ${onHour ? "border-t border-t-slate-700/60" : ""}`}
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

function TimeOff({ timeOff }: { timeOff: Availability[] }) {
  const router = useRouter();
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!date) return;
    setBusy(true);
    await fetch("/api/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specific_date: date, is_available: false, note: note || null, status: "pending" }),
    });
    setBusy(false);
    setDate("");
    setNote("");
    router.refresh();
  }
  async function del(id: number) {
    await fetch(`/api/availability/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
      <div className="text-sm font-medium text-slate-300">Time-off requests</div>
      <p className="text-xs text-slate-500">A manager has to approve these.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-400">Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="ml-2 bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-slate-100" />
        </label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (optional)" className="bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-slate-100 text-sm flex-1 min-w-[140px]" />
        <button onClick={add} disabled={busy || !date} className="text-sm px-3 py-1.5 rounded-md bg-slate-100 text-slate-900 font-medium hover:bg-white disabled:opacity-40">Request</button>
      </div>
      {timeOff.length > 0 && (
        <div className="space-y-1 pt-1">
          {timeOff.map((a) => (
            <div key={a.id} className="flex items-center justify-between text-sm border-b border-slate-800 pb-1 last:border-0">
              <span className="text-slate-300">
                {fmtDate(a.specific_date! + "T12:00:00")} · {statusBadge(a.status)}
                {a.note ? ` · ${a.note}` : ""}
              </span>
              {a.status !== "approved" && (
                <button onClick={() => del(a.id)} className="text-slate-500 hover:text-rose-400 text-xs">Cancel</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
