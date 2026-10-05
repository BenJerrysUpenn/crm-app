"use client";

import { useState } from "react";
import { nyInputToIso, type Person, type PunchFix } from "@/lib/payroll/verify";

// Fix a punch in place on the payroll page (2026-10-05). The finding says what
// to fix (lib/payroll/verify.ts, `fix`); this writes it through the same
// routes the Timesheets page uses, under the same manager check and the same
// row_audit triggers, then hands back so the page runs Verify again. Times
// are New York wall clock, like every finding on the page.

const INPUT =
  "mt-1 w-full min-w-0 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-slate-900 dark:text-slate-100";

export default function PunchFixForm({
  fix,
  staff,
  busy,
  onFixed,
}: {
  fix: PunchFix;
  staff: Person[];
  busy: boolean;
  onFixed: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState(fix.kind === "edit" ? fix.punch.employee_id : (fix.employee_id ?? ""));
  const [clockIn, setClockIn] = useState(
    fix.kind === "edit" ? fix.punch.clock_in : (fix.clock_in ?? `${fix.date}T`),
  );
  const [clockOut, setClockOut] = useState(
    fix.kind === "edit" ? (fix.punch.clock_out ?? "") : (fix.clock_out ?? `${fix.date}T`),
  );
  const [shiftId, setShiftId] = useState(fix.kind === "add" && fix.shift_id ? String(fix.shift_id) : "");

  if (!open) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(true)}
        className="mt-2 rounded-md border border-slate-300 dark:border-slate-700 text-xs font-medium px-3 py-1.5 text-slate-800 dark:text-slate-200 hover:border-emerald-500 disabled:opacity-50"
      >
        {fix.kind === "edit" ? `Fix punch ${fix.punch.id}` : "Add the missing punch"}
      </button>
    );
  }

  async function save() {
    const inIso = nyInputToIso(clockIn);
    const outIso = clockOut ? nyInputToIso(clockOut) : null;
    if (!inIso) return setErr("Enter the clock-in date and time.");
    if (clockOut && !outIso) return setErr("Enter the clock-out date and time, or leave it blank.");
    if (fix.kind === "add" && !employeeId) return setErr("Pick who the punch is for.");
    if (fix.kind === "add" && !outIso) return setErr("Enter the clock-out: a punch added after the fact has an end.");
    setSaving(true);
    setErr(null);
    const res =
      fix.kind === "edit"
        ? await fetch(`/api/time-entries/${fix.punch.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clock_in_at: inIso, clock_out_at: outIso }),
          })
        : await fetch("/api/time-entries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              employee_id: employeeId,
              clock_in_at: inIso,
              clock_out_at: outIso,
              shift_id: shiftId ? Number(shiftId) : null,
            }),
          });
    if (!res.ok) {
      setSaving(false);
      setErr((await res.json().catch(() => ({}))).error ?? `Could not save (${res.status}).`);
      return;
    }
    await onFixed();
    setSaving(false);
    setOpen(false);
  }

  const disabled = busy || saving;
  return (
    <div className="mt-2 rounded-md border border-slate-200 dark:border-slate-700 p-3 text-xs space-y-2 max-w-xl">
      <div className="font-medium text-slate-800 dark:text-slate-200">
        {fix.kind === "edit" ? `Punch ${fix.punch.id} · ${fix.punch.employee_name}` : `Add a punch · ${fix.date}`}
      </div>
      {fix.kind === "add" && (
        <label className="block">
          <span className="text-slate-500">Employee</span>
          <select value={employeeId} disabled={disabled} onChange={(e) => setEmployeeId(e.target.value)} className={INPUT}>
            <option value="">— pick somebody —</option>
            {staff.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block">
          <span className="text-slate-500">Clock in (New York)</span>
          <input type="datetime-local" value={clockIn} disabled={disabled} onChange={(e) => setClockIn(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className="text-slate-500">Clock out (New York)</span>
          <input type="datetime-local" value={clockOut} disabled={disabled} onChange={(e) => setClockOut(e.target.value)} className={INPUT} />
        </label>
      </div>
      {fix.kind === "add" && (
        <label className="block">
          <span className="text-slate-500">Shift (optional)</span>
          <select value={shiftId} disabled={disabled} onChange={(e) => setShiftId(e.target.value)} className={INPUT}>
            <option value="">No shift</option>
            {fix.shifts.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {err && <div className="text-rose-500">{err}</div>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={save}
          className="rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium px-3 py-1.5 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save and verify again"}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setErr(null);
            setOpen(false);
          }}
          className="rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 px-3 py-1.5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
