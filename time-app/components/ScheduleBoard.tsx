"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtTime } from "@/lib/format";
import type { Profile, ShiftWithEmployee, Location, ShiftRequest, ShiftType, Availability, Annotation } from "@/lib/types";

const TZ = "America/New_York";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// All week math is done on YYYY-MM-DD strings in the business timezone so the
// server (UTC) and the browser (Eastern) always agree on which day a shift is on.
function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function nyDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}
function dayLabel(dateStr: string) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
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

type DropReq = ShiftRequest & { profiles?: Pick<Profile, "id" | "full_name"> };

export default function ScheduleBoard({
  isManager,
  weekStart,
  shifts,
  employees,
  locations,
  dropRequests,
  shiftTypes,
  availability = [],
  annotations = [],
}: {
  isManager: boolean;
  weekStart: string; // YYYY-MM-DD (Sunday)
  shifts: ShiftWithEmployee[];
  employees: Profile[];
  locations: Location[];
  dropRequests: DropReq[];
  shiftTypes: ShiftType[];
  availability?: Availability[];
  annotations?: Annotation[];
}) {
  const colorByType = new Map(shiftTypes.map((t) => [t.name, t.color]));

  function fmtT(t: string | null) {
    if (!t) return "any";
    const [h, m] = t.split(":");
    const hr = Number(h);
    const ap = hr >= 12 ? "p" : "a";
    const h12 = hr % 12 === 0 ? 12 : hr % 12;
    return m === "00" ? `${h12}${ap}` : `${h12}:${m}${ap}`;
  }
  // Availability summary for an employee on a specific date (for the modal).
  function availFor(employeeId: string, date: string) {
    const rows = availability.filter((a) => a.employee_id === employeeId && a.specific_date === date);
    const timeOff = rows.find((a) => !a.is_available);
    const blocks = rows.filter((a) => a.is_available);
    return { timeOff, blocks };
  }
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<number | null>(null);
  const [actingReq, setActingReq] = useState<number | null>(null);
  const [droppingId, setDroppingId] = useState<number | null>(null);
  const [ackingId, setAckingId] = useState<number | null>(null);
  const [howMany, setHowMany] = useState(1);
  const [annDraft, setAnnDraft] = useState<null | { title: string; message: string; start_date: string; end_date: string; color: string; business_closed: boolean; no_time_off: boolean; announcement: boolean }>(null);

  async function saveAnnotation() {
    if (!annDraft) return;
    setBusy(true);
    const res = await fetch("/api/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(annDraft),
    });
    setBusy(false);
    if (res.ok) {
      setAnnDraft(null);
      router.refresh();
    }
  }
  async function deleteAnnotation(id: number) {
    await fetch(`/api/annotations/${id}`, { method: "DELETE" });
    router.refresh();
  }

  const OT_THRESHOLD = 40; // hours per week before overtime

  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const rateById = new Map(employees.map((e) => [e.id, e.hourly_rate ?? 0]));
  const nameById = new Map(employees.map((e) => [e.id, e.full_name ?? e.id]));
  const myPendingDrops = new Set(dropRequests.map((r) => r.shift_id));

  async function ack(id: number) {
    setAckingId(id);
    setCopyMsg(null);
    const res = await fetch(`/api/shifts/${id}/ack`, { method: "POST" });
    setAckingId(null);
    if (!res.ok) {
      setCopyMsg((await res.json().catch(() => ({}))).error ?? "Could not confirm.");
      return;
    }
    router.refresh();
  }

  function shiftHours(s: ShiftWithEmployee) {
    return Math.max(0, (new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 3600000);
  }
  // Only shifts that actually fall in the 7 visible days (the query pads a day
  // on each side, so don't count those toward the week's totals).
  const dateSet = new Set(dates);
  const weekShifts = shifts.filter((s) => dateSet.has(nyDate(s.starts_at)));
  // Employees: count only shifts assigned to them (ignore open shifts they could
  // pick up). Managers: count all assigned coverage.
  const countedShifts = isManager ? weekShifts : weekShifts.filter((s) => s.employee_id);
  const weekHours = countedShifts.reduce((sum, s) => sum + shiftHours(s), 0);
  const weekCost = isManager
    ? weekShifts.reduce((sum, s) => sum + shiftHours(s) * (s.employee_id ? rateById.get(s.employee_id) ?? 0 : 0), 0)
    : 0;

  async function requestDrop(id: number) {
    setDroppingId(id);
    setCopyMsg(null);
    const res = await fetch(`/api/shifts/${id}/drop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setDroppingId(null);
    if (!res.ok) {
      setCopyMsg((await res.json().catch(() => ({}))).error ?? "Could not request drop.");
      return;
    }
    setCopyMsg("Drop requested. A manager will review it.");
    router.refresh();
  }

  async function decideReq(id: number, status: "approved" | "denied") {
    setActingReq(id);
    await fetch(`/api/shift-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setActingReq(null);
    router.refresh();
  }

  async function claim(id: number) {
    setClaimingId(id);
    setCopyMsg(null);
    const res = await fetch(`/api/shifts/${id}/claim`, { method: "POST" });
    setClaimingId(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setCopyMsg(j.error ?? "Could not pick up that shift.");
      return;
    }
    setCopyMsg("Shift added to your schedule.");
    router.refresh();
  }

  async function autoFill() {
    setCopying(true);
    setCopyMsg(null);
    const res = await fetch("/api/schedule/auto-fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekStart }),
    });
    setCopying(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setCopyMsg(j.error ?? "Auto-fill failed.");
      return;
    }
    setCopyMsg(
      j.assigned
        ? `Auto-assigned ${j.assigned} open shift${j.assigned === 1 ? "" : "s"}${j.left ? `, ${j.left} left open (no one available).` : "."}`
        : "No open shifts could be filled (check availability and time off).",
    );
    router.refresh();
  }

  async function copyLastWeek() {
    setCopying(true);
    setCopyMsg(null);
    const res = await fetch("/api/shifts/copy-week", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekStart }),
    });
    setCopying(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setCopyMsg(j.error ?? "Copy failed.");
      return;
    }
    setCopyMsg(j.copied ? `Copied ${j.copied} shifts from last week (as drafts).` : "No shifts found last week.");
    router.refresh();
  }

  function shiftsForDay(dateStr: string) {
    return shifts.filter((s) => nyDate(s.starts_at) === dateStr);
  }

  function gotoWeek(deltaDays: number) {
    router.push(`/schedule?week=${addDays(weekStart, deltaDays)}`);
  }

  function newShift(dateStr: string, employeeId?: string) {
    setErr(null);
    setHowMany(1);
    setDraft({
      employee_id: employeeId ?? employees[0]?.id ?? "",
      location_id: String(locations.find((l) => l.is_default)?.id ?? locations[0]?.id ?? ""),
      starts_at: `${dateStr}T09:00`,
      ends_at: `${dateStr}T17:00`,
      position: "",
      notes: "",
      published: false,
    });
  }

  function editShift(s: ShiftWithEmployee) {
    setErr(null);
    setDraft({
      id: s.id,
      employee_id: s.employee_id ?? "",
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
    const start = new Date(draft.starts_at);
    const end = new Date(draft.ends_at);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      setErr("Pick a valid start and end time.");
      return;
    }
    if (end <= start) {
      setErr("End time must be after the start time.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        employee_id: draft.employee_id || null,
        location_id: draft.location_id ? Number(draft.location_id) : null,
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        position: draft.position || null,
        notes: draft.notes || null,
        published: publish || draft.published,
      };
      // Open shifts can be created in bulk (How Many).
      const count = !draft.id && !draft.employee_id ? Math.max(1, Math.min(20, howMany)) : 1;
      const url = draft.id ? `/api/shifts/${draft.id}` : "/api/shifts";
      for (let i = 0; i < count; i++) {
        const res = await fetch(url, {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setErr(j.error ?? `Save failed (${res.status}).`);
          return;
        }
      }
      setDraft(null);
      router.refresh();
    } catch (e) {
      setErr((e as Error)?.message ?? "Network error.");
    } finally {
      setBusy(false);
    }
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
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Schedule</h1>
        <div className="flex flex-wrap items-center gap-2">
          {isManager && (
            <>
              <button onClick={autoFill} disabled={copying} className="px-2.5 py-1 text-sm rounded-md bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50">
                {copying ? "Working…" : "Auto-fill"}
              </button>
              <button onClick={copyLastWeek} disabled={copying} className="px-2.5 py-1 text-sm rounded-md border border-slate-400 dark:border-slate-600 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50">
                {copying ? "…" : "Copy last week"}
              </button>
              <button onClick={() => setAnnDraft({ title: "", message: "", start_date: dates[0], end_date: dates[0], color: "#0ea5e9", business_closed: false, no_time_off: false, announcement: false })} className="px-2.5 py-1 text-sm rounded-md border border-slate-400 dark:border-slate-600 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">
                + Annotation
              </button>
            </>
          )}
          <button onClick={() => gotoWeek(-7)} className="px-2.5 py-1 text-sm rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">‹ Prev</button>
          <button onClick={() => router.push("/schedule")} className="px-2.5 py-1 text-sm rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">This week</button>
          <button onClick={() => gotoWeek(7)} className="px-2.5 py-1 text-sm rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">Next ›</button>
        </div>
      </div>
      {copyMsg && <div className="text-sm text-emerald-400 mb-3">{copyMsg}</div>}

      {/* Annotations */}
      {annotations.length > 0 && (
        <div className="space-y-2 mb-3">
          {annotations.map((a) => (
            <div key={a.id} style={{ borderLeft: `4px solid ${a.color}` }} className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 px-3 py-2 flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  {a.title}
                  {a.business_closed && <span className="ml-2 text-xs text-rose-500">Closed</span>}
                  {a.no_time_off && <span className="ml-2 text-xs text-amber-500">No time off</span>}
                  {a.announcement && <span className="ml-2 text-xs text-sky-500">Announcement</span>}
                </div>
                {a.message && <div className="text-xs text-slate-500 mt-0.5">{a.message}</div>}
                <div className="text-[11px] text-slate-400 mt-0.5">{dayLabel(a.start_date)}{a.end_date !== a.start_date ? ` – ${dayLabel(a.end_date)}` : ""}</div>
              </div>
              {isManager && <button onClick={() => deleteAnnotation(a.id)} className="text-xs text-slate-500 hover:text-rose-400 shrink-0">Remove</button>}
            </div>
          ))}
        </div>
      )}

      {/* Week totals */}
      <div className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        {weekHours.toFixed(1)} scheduled hours this week
        {isManager && weekCost > 0 && (
          <span> · projected labor ${weekCost.toFixed(0)}</span>
        )}
      </div>

      {/* Manager: hours by person, with overtime flagged */}
      {isManager && (() => {
        const byEmp = new Map<string, number>();
        for (const s of weekShifts) {
          if (!s.employee_id) continue;
          byEmp.set(s.employee_id, (byEmp.get(s.employee_id) ?? 0) + shiftHours(s));
        }
        const rows = Array.from(byEmp.entries()).sort((a, b) => b[1] - a[1]);
        const anyOT = rows.some(([, h]) => h > OT_THRESHOLD);
        if (rows.length === 0) return null;
        return (
          <div className={`rounded-lg p-4 mb-4 border ${anyOT ? "border-amber-700 bg-amber-950/20" : "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"}`}>
            <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              Hours by person{anyOT && <span className="text-amber-400"> · overtime ahead</span>}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {rows.map(([id, h]) => {
                const ot = h > OT_THRESHOLD;
                return (
                  <span key={id} className="text-sm">
                    <span className="text-slate-700 dark:text-slate-300">{nameById.get(id) ?? "—"}</span>{" "}
                    <span className={ot ? "text-amber-400 font-medium" : "text-slate-600 dark:text-slate-400"}>
                      {h.toFixed(1)}h{ot ? ` (OT +${(h - OT_THRESHOLD).toFixed(1)})` : ""}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Manager: pending drop requests */}
      {isManager && dropRequests.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-amber-900 rounded-lg p-4 mb-4">
          <div className="text-sm font-medium text-amber-300 mb-2">
            Drop requests ({dropRequests.length})
          </div>
          <div className="space-y-2">
            {dropRequests.map((r) => {
              const s = shifts.find((x) => x.id === r.shift_id);
              return (
                <div key={r.id} className="flex items-center justify-between gap-3 text-sm border-b border-slate-200 dark:border-slate-800 pb-2 last:border-0">
                  <span className="text-slate-800 dark:text-slate-200">
                    {r.profiles?.full_name ?? "Employee"} wants to drop{" "}
                    {s ? `${dayLabel(nyDate(s.starts_at))} ${fmtTime(s.starts_at)}–${fmtTime(s.ends_at)}` : "a shift"}
                    {r.note ? ` · ${r.note}` : ""}
                  </span>
                  <span className="flex gap-2 shrink-0">
                    <button onClick={() => decideReq(r.id, "approved")} disabled={actingReq === r.id} className="text-xs px-2 py-1 rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-50">Approve</button>
                    <button onClick={() => decideReq(r.id, "denied")} disabled={actingReq === r.id} className="text-xs px-2 py-1 rounded-md border border-rose-800 text-rose-300 hover:bg-rose-950">Deny</button>
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-slate-500 mt-2">Approving releases the shift back to open so others can pick it up.</p>
        </div>
      )}

      {isManager && (
        <ManagerMatrix
          dates={dates}
          employees={employees}
          shiftsForDay={shiftsForDay}
          shiftHours={shiftHours}
          colorByType={colorByType}
          editShift={editShift}
          newShift={newShift}
          fmtTime={fmtTime}
          dayLabel={dayLabel}
          DAYS={DAYS}
        />
      )}

      {!isManager && (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3">
        {dates.map((dateStr, i) => (
          <div key={i} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3 min-h-[120px]">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-slate-600 dark:text-slate-400">
                {DAYS[i]} {dayLabel(dateStr)}
                {(() => {
                  const h = shiftsForDay(dateStr).reduce((sum, s) => sum + shiftHours(s), 0);
                  return h > 0 ? <span className="text-slate-600"> · {h.toFixed(1)}h</span> : null;
                })()}
              </div>
              {isManager && (
                <button onClick={() => newShift(dateStr)} className="text-slate-600 dark:text-slate-400 hover:text-emerald-400 text-lg leading-none">+</button>
              )}
            </div>
            <div className="space-y-2">
              {shiftsForDay(dateStr).map((s) => (
                <div
                  key={s.id}
                  onClick={() => isManager && editShift(s)}
                  style={s.position && colorByType.get(s.position) ? { borderLeft: `4px solid ${colorByType.get(s.position)}` } : undefined}
                  className={`rounded-md px-2 py-1.5 text-xs border ${
                    isManager ? "cursor-pointer" : ""
                  } ${
                    s.published
                      ? "bg-slate-100 dark:bg-slate-800/70 border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200"
                      : "bg-slate-100 dark:bg-slate-800/30 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400"
                  }`}
                >
                  <div className="font-medium">{fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}</div>
                  {isManager ? (
                    <div className={s.employee_id ? "text-slate-600 dark:text-slate-400" : "text-amber-400"}>
                      {s.employee_id ? (s.profiles?.full_name ?? "—") : "Open shift"}
                    </div>
                  ) : (
                    !s.employee_id && <div className="text-amber-400">Open shift</div>
                  )}
                  {s.position && (
                    <div className="flex items-center gap-1 text-slate-600 dark:text-slate-400">
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: colorByType.get(s.position) ?? "#64748b" }} />
                      {s.position}
                    </div>
                  )}
                  {s.notes && <div className="text-slate-600 dark:text-slate-400 italic mt-0.5">{s.notes}</div>}
                  {!s.published && <div className="text-amber-400 mt-0.5">draft</div>}
                  {isManager && s.published && s.employee_id && (
                    <div className={s.acknowledged_at ? "text-emerald-400 mt-0.5" : "text-slate-500 mt-0.5"}>
                      {s.acknowledged_at ? "✓ confirmed" : "awaiting confirm"}
                    </div>
                  )}
                  {!isManager && !s.employee_id && (
                    <button
                      onClick={() => claim(s.id)}
                      disabled={claimingId === s.id}
                      className="mt-2 w-full rounded-md bg-emerald-500 text-slate-950 font-medium py-1 hover:bg-emerald-400 disabled:opacity-50"
                    >
                      {claimingId === s.id ? "Picking up…" : "Pick up"}
                    </button>
                  )}
                  {!isManager && s.employee_id && (
                    <>
                      {s.acknowledged_at ? (
                        <div className="mt-2 text-emerald-400">✓ Confirmed</div>
                      ) : (
                        <button
                          onClick={() => ack(s.id)}
                          disabled={ackingId === s.id}
                          className="mt-2 w-full rounded-md bg-emerald-500 text-slate-950 font-medium py-1 hover:bg-emerald-400 disabled:opacity-50"
                        >
                          {ackingId === s.id ? "Confirming…" : "Confirm"}
                        </button>
                      )}
                      {myPendingDrops.has(s.id) ? (
                        <div className="mt-2 text-amber-400">Drop requested</div>
                      ) : (
                        <button
                          onClick={() => requestDrop(s.id)}
                          disabled={droppingId === s.id}
                          className="mt-1 w-full rounded-md border border-slate-400 dark:border-slate-600 text-slate-800 dark:text-slate-200 py-1 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                        >
                          {droppingId === s.id ? "Requesting…" : "Drop shift"}
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      )}

      {annDraft && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 px-4" onClick={() => setAnnDraft(null)}>
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl p-5 w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold text-slate-900 dark:text-slate-100">Add annotation</h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs text-slate-600 dark:text-slate-400">Start date
                <input type="date" value={annDraft.start_date} onChange={(e) => setAnnDraft({ ...annDraft, start_date: e.target.value })} className="mt-1 w-full min-w-0 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100" />
              </label>
              <label className="block text-xs text-slate-600 dark:text-slate-400">End date
                <input type="date" value={annDraft.end_date} min={annDraft.start_date} onChange={(e) => setAnnDraft({ ...annDraft, end_date: e.target.value })} className="mt-1 w-full min-w-0 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100" />
              </label>
            </div>
            <label className="block text-xs text-slate-600 dark:text-slate-400">Title
              <input value={annDraft.title} onChange={(e) => setAnnDraft({ ...annDraft, title: e.target.value })} placeholder="Closed for July 4th, Big event…" className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100" />
            </label>
            <label className="block text-xs text-slate-600 dark:text-slate-400">Message
              <textarea value={annDraft.message} onChange={(e) => setAnnDraft({ ...annDraft, message: e.target.value })} rows={2} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100" />
            </label>
            <div className="flex items-center gap-3">
              <label className="block text-xs text-slate-600 dark:text-slate-400">Color
                <input type="color" value={annDraft.color} onChange={(e) => setAnnDraft({ ...annDraft, color: e.target.value })} className="ml-2 align-middle w-9 h-8 rounded border border-slate-300 dark:border-slate-700" />
              </label>
            </div>
            <div className="space-y-1 text-sm text-slate-700 dark:text-slate-300">
              <label className="flex items-center gap-2"><input type="checkbox" checked={annDraft.business_closed} onChange={(e) => setAnnDraft({ ...annDraft, business_closed: e.target.checked })} /> Business closed</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={annDraft.no_time_off} onChange={(e) => setAnnDraft({ ...annDraft, no_time_off: e.target.checked })} /> Don&apos;t allow time off</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={annDraft.announcement} onChange={(e) => setAnnDraft({ ...annDraft, announcement: e.target.checked })} /> Announcement</label>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setAnnDraft(null)} className="px-3 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">Cancel</button>
              <button onClick={saveAnnotation} disabled={busy || !annDraft.title} className="px-3 py-1.5 text-sm rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-50">Save</button>
            </div>
          </div>
        </div>
      )}

      {draft && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 px-4" onClick={() => setDraft(null)}>
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl p-5 w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold text-slate-900 dark:text-slate-100">{draft.id ? "Edit shift" : "New shift"}</h2>

            {/* Suggestions: shift types with default times */}
            {!draft.id && shiftTypes.some((t) => t.default_start && t.default_end) && (
              <div>
                <div className="text-xs text-slate-500 mb-1">Suggestions</div>
                <div className="grid grid-cols-2 gap-2">
                  {shiftTypes.filter((t) => t.default_start && t.default_end).map((t) => {
                    const d = draft.starts_at.slice(0, 10);
                    return (
                      <button
                        key={t.id}
                        onClick={() => setDraft({ ...draft, position: t.name, starts_at: `${d}T${t.default_start!.slice(0, 5)}`, ends_at: `${d}T${t.default_end!.slice(0, 5)}` })}
                        style={{ borderLeft: `4px solid ${t.color}` }}
                        className="text-left text-xs rounded-md border border-slate-300 dark:border-slate-700 px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        <div className="font-medium text-slate-800 dark:text-slate-200">{fmtT(t.default_start)}–{fmtT(t.default_end)}</div>
                        <div className="text-slate-500">{t.name}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-xs text-slate-600 dark:text-slate-400">Employee
                <select value={draft.employee_id} onChange={(e) => setDraft({ ...draft, employee_id: e.target.value })} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100">
                  <option value="">Open (unassigned)</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name ?? e.id}</option>)}
                </select>
              </label>
              {!draft.id && !draft.employee_id && (
                <label className="block text-xs text-slate-600 dark:text-slate-400">How many
                  <input type="number" min={1} max={20} value={howMany} onChange={(e) => setHowMany(Number(e.target.value))} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100" />
                </label>
              )}
            </div>
            {draft.employee_id && draft.starts_at && (() => {
              const { timeOff, blocks } = availFor(draft.employee_id, draft.starts_at.slice(0, 10));
              const by = (p: string) => blocks.filter((b) => (b.preference ?? "available") === p);
              const pref = by("preferred"), avail = by("available"), unavail = by("unavailable");
              return (
                <div className="rounded-md border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/40 px-3 py-2 text-xs space-y-1">
                  <div className="text-slate-600 dark:text-slate-400">Availability that day</div>
                  {timeOff && (
                    <div className="text-rose-300">Time off ({timeOff.status})</div>
                  )}
                  {pref.length > 0 && <div className="text-sky-300">Prefers: {pref.map((b) => `${fmtT(b.start_time)}–${fmtT(b.end_time)}`).join(", ")}</div>}
                  {avail.length > 0 && <div className="text-emerald-300">Available: {avail.map((b) => `${fmtT(b.start_time)}–${fmtT(b.end_time)}`).join(", ")}</div>}
                  {unavail.length > 0 && <div className="text-rose-300">Can&apos;t work: {unavail.map((b) => `${fmtT(b.start_time)}–${fmtT(b.end_time)}`).join(", ")}</div>}
                  {!timeOff && blocks.length === 0 && <div className="text-slate-500">No availability submitted.</div>}
                </div>
              );
            })()}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-xs text-slate-600 dark:text-slate-400">Start
                <input type="datetime-local" value={draft.starts_at} onChange={(e) => setDraft({ ...draft, starts_at: e.target.value })} className="mt-1 w-full min-w-0 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100" />
              </label>
              <label className="block text-xs text-slate-600 dark:text-slate-400">End
                <input type="datetime-local" value={draft.ends_at} onChange={(e) => setDraft({ ...draft, ends_at: e.target.value })} className="mt-1 w-full min-w-0 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100" />
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-xs text-slate-600 dark:text-slate-400">Shift type
                <select value={draft.position} onChange={(e) => setDraft({ ...draft, position: e.target.value })} className="mt-1 w-full min-w-0 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100">
                  <option value="">—</option>
                  {shiftTypes.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                </select>
              </label>
              <label className="block text-xs text-slate-600 dark:text-slate-400">Location
                <select value={draft.location_id} onChange={(e) => setDraft({ ...draft, location_id: e.target.value })} className="mt-1 w-full min-w-0 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100">
                  <option value="">—</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-xs text-slate-600 dark:text-slate-400">Notes
              <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-slate-900 dark:text-slate-100" />
            </label>
            {err && <div className="text-sm text-rose-300">{err}</div>}
            <div className="flex items-center justify-between pt-2">
              {draft.id ? (
                <button onClick={remove} disabled={busy} className="text-sm text-rose-400 hover:text-rose-300">Delete</button>
              ) : <span />}
              <div className="flex gap-2">
                <button onClick={() => save(false)} disabled={busy} className="px-3 py-1.5 text-sm rounded-md border border-slate-400 dark:border-slate-600 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50">{busy ? "Saving…" : "Save draft"}</button>
                <button onClick={() => save(true)} disabled={busy} className="px-3 py-1.5 text-sm rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-50">{busy ? "Publishing…" : "Publish"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manager matrix view: employees down the side, days across the top.
// ---------------------------------------------------------------------------
function ManagerMatrix({
  dates,
  employees,
  shiftsForDay,
  shiftHours,
  colorByType,
  editShift,
  newShift,
  fmtTime,
  dayLabel,
  DAYS,
}: {
  dates: string[];
  employees: Profile[];
  shiftsForDay: (d: string) => ShiftWithEmployee[];
  shiftHours: (s: ShiftWithEmployee) => number;
  colorByType: Map<string, string>;
  editShift: (s: ShiftWithEmployee) => void;
  newShift: (d: string, employeeId?: string) => void;
  fmtTime: (iso: string | null) => string;
  dayLabel: (d: string) => string;
  DAYS: string[];
}) {
  function cellShifts(date: string, employeeId: string | null) {
    return shiftsForDay(date).filter((s) =>
      employeeId === null ? !s.employee_id : s.employee_id === employeeId,
    );
  }
  function weekHoursFor(employeeId: string | null) {
    return dates.reduce(
      (sum, d) => sum + cellShifts(d, employeeId).reduce((a, s) => a + shiftHours(s), 0),
      0,
    );
  }

  const cols = `170px repeat(7, minmax(120px, 1fr))`;

  function Chip({ s }: { s: ShiftWithEmployee }) {
    const color = s.position ? colorByType.get(s.position) : undefined;
    return (
      <button
        onClick={() => editShift(s)}
        style={color ? { borderLeft: `4px solid ${color}` } : undefined}
        className={`w-full text-left rounded-md px-2 py-1 text-[11px] mb-1 border ${
          s.published
            ? "bg-slate-100 dark:bg-slate-800/70 border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200"
            : "bg-slate-100/60 dark:bg-slate-800/30 border-dashed border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400"
        }`}
      >
        <div className="font-medium">{fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}</div>
        {s.position && <div className="text-slate-500">{s.position}</div>}
        {!s.published && <div className="text-amber-500">draft</div>}
        {s.published && s.employee_id && (
          <div className={s.acknowledged_at ? "text-emerald-500" : "text-slate-500"}>
            {s.acknowledged_at ? "✓ confirmed" : "awaiting confirm"}
          </div>
        )}
      </button>
    );
  }

  function Row({ id, label, sub, tint }: { id: string | null; label: string; sub: string; tint?: boolean }) {
    return (
      <div className="grid border-b border-slate-200 dark:border-slate-800" style={{ gridTemplateColumns: cols }}>
        <div className={`px-3 py-2 border-r border-slate-200 dark:border-slate-800 sticky left-0 z-10 ${tint ? "bg-emerald-50 dark:bg-emerald-950/30" : "bg-white dark:bg-slate-900"}`}>
          <div className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{label}</div>
          <div className="text-[11px] text-slate-500">{sub}</div>
        </div>
        {dates.map((d, i) => {
          const cs = cellShifts(d, id);
          return (
            <div key={i} className={`px-1.5 py-1.5 border-r border-slate-200 dark:border-slate-800 min-h-[56px] ${tint ? "bg-emerald-50/40 dark:bg-emerald-950/10" : ""}`}>
              {cs.map((s) => <Chip key={s.id} s={s} />)}
              <button
                onClick={() => newShift(d, id ?? "")}
                className="w-full text-[11px] text-slate-400 hover:text-emerald-500 border border-dashed border-slate-300 dark:border-slate-700 rounded-md py-1"
              >
                + Add
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto">
      {/* Header */}
      <div className="grid bg-slate-100 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800" style={{ gridTemplateColumns: cols }}>
        <div className="px-3 py-2 sticky left-0 bg-slate-100 dark:bg-slate-800/60 z-10 text-xs font-medium text-slate-500">Staff</div>
        {dates.map((d, i) => {
          const h = shiftsForDay(d).reduce((a, s) => a + shiftHours(s), 0);
          return (
            <div key={i} className="px-2 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 border-l border-slate-200 dark:border-slate-800">
              {DAYS[i]} {dayLabel(d)}{h > 0 ? ` · ${h.toFixed(1)}h` : ""}
            </div>
          );
        })}
      </div>
      {/* Open shifts row */}
      <Row id={null} label="Open shifts" sub={`${weekHoursFor(null).toFixed(1)}h open`} tint />
      {/* Employee rows */}
      {employees.map((e) => (
        <Row key={e.id} id={e.id} label={e.full_name ?? e.id} sub={`${weekHoursFor(e.id).toFixed(1)}h`} />
      ))}
    </div>
  );
}
