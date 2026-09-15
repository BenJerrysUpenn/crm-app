"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ClockinRemindersAdmin, { type ReminderWithAcks } from "@/components/ClockinRemindersAdmin";
import StaffingRecords, { post, primaryBtn, quietBtn } from "@/components/StaffingRecords";
import type { LifecycleWithSteps, Profile, Location, ShiftType } from "@/lib/types";
import type { AppSettings } from "@/lib/settings";
import {
  FINAL_PAY_NOTE_DEFAULT,
  OFFBOARD_REASONS,
  SYSTEMS,
  SYSTEMS_DEFAULT,
  type System,
} from "@/lib/staffing/catalogue";

const field =
  "text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-slate-900 dark:text-slate-100 w-full";
const fieldLabel = "block text-xs text-slate-600 dark:text-slate-400";

function displayName(p: Profile, email: string) {
  const n = p.full_name && !p.full_name.includes("@") ? p.full_name : null;
  return n ?? email ?? p.id;
}

// The "also invite to" / "also remove from" checkboxes shared by the add,
// re-invite and offboard forms.
function SystemPicker({
  value,
  onChange,
  verb,
}: {
  value: System[];
  onChange: (v: System[]) => void;
  verb: string;
}) {
  return (
    <div>
      <div className={fieldLabel}>{verb}</div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        <label className="text-xs text-slate-500 flex items-center gap-1">
          <input type="checkbox" checked disabled /> Withers-time (always)
        </label>
        {SYSTEMS.map((sy) => (
          <label key={sy.key} className="text-xs text-slate-700 dark:text-slate-300 flex items-center gap-1" title={sy.hint}>
            <input
              type="checkbox"
              checked={value.includes(sy.key)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, sy.key] : value.filter((k) => k !== sy.key))
              }
            />
            {sy.label}
          </label>
        ))}
      </div>
    </div>
  );
}

export default function TeamAdmin({
  employees,
  locations,
  emailById,
  settings,
  shiftTypes,
  reminders,
  employeeCount,
  records,
}: {
  employees: Profile[];
  locations: Location[];
  emailById: Record<string, string>;
  settings: AppSettings;
  shiftTypes: ShiftType[];
  reminders: ReminderWithAcks[];
  employeeCount: number;
  records: LifecycleWithSteps[];
}) {
  const router = useRouter();
  const [savingId, setSavingId] = useState<string | null>(null);
  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of employees) m[p.id] = displayName(p, emailById[p.id] ?? "");
    return m;
  }, [employees, emailById]);

  // Add-employee form state. Open by clicking the "+ Add employee" button.
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addOk, setAddOk] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPreferred, setNewPreferred] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newRole, setNewRole] = useState<"employee" | "manager">("employee");
  const [newRate, setNewRate] = useState<string>("");
  const [newStart, setNewStart] = useState("");
  const [newFob, setNewFob] = useState("");
  const [newSystems, setNewSystems] = useState<System[]>(SYSTEMS_DEFAULT);

  async function saveProfile(id: string, patch: Partial<Profile>) {
    setSavingId(id);
    await fetch(`/api/profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSavingId(null);
    router.refresh();
  }

  // Creates the Withers-time account and emails the invite (the app does
  // that itself), queues the ticked systems for the onboarding worker, and
  // opens a checklist below the table.
  async function addEmployee() {
    setAddErr(null);
    setAddOk(null);
    const email = newEmail.trim();
    if (!email || !email.includes("@")) {
      setAddErr("Enter a valid email.");
      return;
    }
    const fullName = newName.trim();
    if (!fullName || fullName.includes("@")) {
      setAddErr("Enter the person's full name.");
      return;
    }
    setAddBusy(true);
    try {
      const data = await post("/api/staffing", "POST", {
        kind: "onboarding",
        email,
        legal_name: fullName,
        preferred_name: newPreferred.trim() || undefined,
        role: newRole,
        phone: newPhone.trim() || undefined,
        pay_rate: newRate ? Number(newRate) : undefined,
        start_date: newStart || undefined,
        fob_card_id: newFob.trim() || undefined,
        systems: newSystems,
      });
      const rec = data.record as LifecycleWithSteps;
      const invite = rec.steps.find((st) => st.key === "withers_time_invite");
      if (invite?.status === "done") {
        const others = newSystems.filter((k) => k !== "fob").length;
        setAddOk(
          `Invite emailed to ${email}. They'll set a password from the link and then appear here.` +
            (others ? ` ${others} other system${others === 1 ? "" : "s"} queued for the worker; see the checklist below.` : ""),
        );
        setNewEmail("");
        setNewName("");
        setNewPreferred("");
        setNewPhone("");
        setNewRole("employee");
        setNewRate("");
        setNewStart("");
        setNewFob("");
        setNewSystems(SYSTEMS_DEFAULT);
      } else {
        setAddErr(`Withers-time invite failed: ${invite?.result ?? "unknown"}. Fix and press Retry on the record below.`);
      }
      router.refresh();
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-start justify-between mb-1 gap-3">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Team</h1>
          <button
            type="button"
            onClick={() => { setAddOpen((v) => !v); setAddErr(null); setAddOk(null); }}
            className={primaryBtn}
          >
            {addOpen ? "Cancel" : "+ Add employee"}
          </button>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
          Add a person to invite them by email; tick the other systems to set them up on and the
          onboarding worker does those as the manager. Each row has Re-invite and Offboard.
          Nothing here ever deletes a person or their hours.
        </p>
        {addOpen && (
          <div className="mb-4 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input type="email" placeholder="email (required)" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className={field} />
              <input type="text" required placeholder="full legal name (required, as on payroll)" value={newName} onChange={(e) => setNewName(e.target.value)} className={field} />
              <input type="text" placeholder="preferred name" value={newPreferred} onChange={(e) => setNewPreferred(e.target.value)} className={field} />
              <input type="tel" placeholder="phone (for SMS)" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} className={field} />
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as "employee" | "manager")} className={field}>
                <option value="employee">Employee</option>
                <option value="manager">Manager</option>
              </select>
              <input type="number" step="0.01" placeholder="hourly rate" value={newRate} onChange={(e) => setNewRate(e.target.value)} className={field} />
              <label className={fieldLabel}>Start date
                <input type="date" value={newStart} onChange={(e) => setNewStart(e.target.value)} className={field} />
              </label>
              <label className={fieldLabel}>Fob card id (if already tapped on the Pi)
                <input type="text" value={newFob} onChange={(e) => setNewFob(e.target.value)} className={field} placeholder="raw id from the Pi log" />
              </label>
            </div>
            <SystemPicker value={newSystems} onChange={setNewSystems} verb="Also set up on" />
            {addErr && <div className="text-xs text-rose-500">{addErr}</div>}
            {addOk && <div className="text-xs text-emerald-500">{addOk}</div>}
            <div className="flex justify-end">
              <button type="button" onClick={addEmployee} disabled={addBusy} className={primaryBtn}>
                {addBusy ? "Inviting…" : "Send invite"}
              </button>
            </div>
          </div>
        )}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 text-xs">
              <tr>
                <th className="text-left px-3 py-2">Email</th>
                <th className="text-left px-3 py-2">Name</th>
                <th className="text-left px-3 py-2">Phone</th>
                <th className="text-left px-3 py-2">Role</th>
                <th className="text-right px-3 py-2">Rate $/h</th>
                <th className="text-center px-3 py-2">Active</th>
                <th className="text-left px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <EmployeeRow key={e.id} e={e} email={emailById[e.id] ?? ""} saving={savingId === e.id} onSave={saveProfile} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <StaffingRecords records={records} nameById={nameById} />

      <ClockinRemindersAdmin
        reminders={reminders}
        employees={employees.filter((e) => e.active)}
        employeeCount={employeeCount}
      />

      <ShiftTypesSection shiftTypes={shiftTypes} />

      <LocationSection locations={locations} />

      <SettingsSection settings={settings} />
    </div>
  );
}

function ShiftTypesSection({ shiftTypes }: { shiftTypes: ShiftType[] }) {
  const router = useRouter();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#10b981");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!newName.trim()) return;
    setBusy(true);
    await fetch("/api/shift-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), color: newColor, sort_order: shiftTypes.length + 1 }),
    });
    setBusy(false);
    setNewName("");
    router.refresh();
  }
  async function save(id: number, patch: Partial<ShiftType>) {
    await fetch(`/api/shift-types/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    router.refresh();
  }
  async function remove(id: number) {
    await fetch(`/api/shift-types/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Shift types</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">These appear in the schedule dropdown and color-code shifts.</p>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
        {shiftTypes.map((t) => (
          <ShiftTypeRow key={t.id} t={t} onSave={save} onRemove={remove} />
        ))}
        <div className="flex items-center gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
          <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="w-9 h-9 rounded bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700" />
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New shift type name" className="flex-1 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-slate-900 dark:text-slate-100 text-sm" />
          <button onClick={add} disabled={busy || !newName.trim()} className="px-3 py-1.5 text-sm rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50">Add</button>
        </div>
      </div>
    </section>
  );
}

function ShiftTypeRow({
  t,
  onSave,
  onRemove,
}: {
  t: ShiftType;
  onSave: (id: number, patch: Partial<ShiftType>) => void;
  onRemove: (id: number) => void;
}) {
  const [name, setName] = useState(t.name);
  const [color, setColor] = useState(t.color);
  const [ds, setDs] = useState((t.default_start ?? "").slice(0, 5));
  const [de, setDe] = useState((t.default_end ?? "").slice(0, 5));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input type="color" value={color} onChange={(e) => { setColor(e.target.value); onSave(t.id, { color: e.target.value }); }} className="w-9 h-9 rounded bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700" />
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== t.name && onSave(t.id, { name })} className="flex-1 min-w-[120px] bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-slate-900 dark:text-slate-100 text-sm" />
      <span className="text-[11px] text-slate-500">default</span>
      <input type="time" value={ds} onChange={(e) => setDs(e.target.value)} onBlur={() => onSave(t.id, { default_start: ds ? ds + ":00" : null } as Partial<ShiftType>)} className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-slate-900 dark:text-slate-100 text-xs" />
      <input type="time" value={de} onChange={(e) => setDe(e.target.value)} onBlur={() => onSave(t.id, { default_end: de ? de + ":00" : null } as Partial<ShiftType>)} className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-slate-900 dark:text-slate-100 text-xs" />
      <button onClick={() => onRemove(t.id)} className="text-xs text-slate-500 hover:text-rose-400 px-2">Remove</button>
    </div>
  );
}

function SettingsSection({ settings }: { settings: AppSettings }) {
  const [empGrace, setEmpGrace] = useState(String(settings.employee_clockin_grace_min));
  const [mgrGrace, setMgrGrace] = useState(String(settings.manager_clockin_grace_min));
  const [tardy, setTardy] = useState(String(settings.tardy_grace_min));
  const [reminder, setReminder] = useState(String(settings.shift_reminder_lead_min));
  const [clockout, setClockout] = useState(String(settings.clockout_reminder_after_min));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        employee_clockin_grace_min: Number(empGrace),
        manager_clockin_grace_min: Number(mgrGrace),
        tardy_grace_min: Number(tardy),
        shift_reminder_lead_min: Number(reminder),
        clockout_reminder_after_min: Number(clockout),
      }),
    });
    setBusy(false);
    setMsg(res.ok ? "Saved." : (await res.json().catch(() => ({}))).error ?? "Save failed.");
  }

  const Field = ({ label, value, set, hint }: { label: string; value: string; set: (v: string) => void; hint: string }) => (
    <label className="block text-xs text-slate-600 dark:text-slate-400">
      {label}
      <div className="mt-1 flex items-center gap-2">
        <input type="number" min={0} value={value} onChange={(e) => set(e.target.value)} className="w-20 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-slate-900 dark:text-slate-100" />
        <span className="text-slate-500">minutes</span>
      </div>
      <span className="text-[11px] text-slate-600">{hint}</span>
    </label>
  );

  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Timing &amp; alerts</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">Grace periods used for reminders, missed-clock-in alerts, and attendance.</p>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Employee missed clock-in" value={empGrace} set={setEmpGrace} hint="Nudge the employee this long after their shift starts." />
        <Field label="Manager missed clock-in" value={mgrGrace} set={setMgrGrace} hint="Escalate to managers this long after the start." />
        <Field label="Tardy threshold" value={tardy} set={setTardy} hint="Clock-ins later than this count as late on attendance." />
        <Field label="Shift reminder lead" value={reminder} set={setReminder} hint="Remind employees this long before a shift." />
        <Field label="Clock-out reminder (minutes after shift end)" value={clockout} set={setClockout} hint="Nudge anyone still clocked in this long after their shift ended." />
        <div className="sm:col-span-2 flex items-center gap-3">
          <button onClick={save} disabled={busy} className="px-3 py-1.5 text-sm rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50">
            {busy ? "Saving…" : "Save settings"}
          </button>
          {msg && <span className="text-sm text-emerald-400">{msg}</span>}
        </div>
      </div>
    </section>
  );
}

function EmployeeRow({
  e,
  email,
  saving,
  onSave,
}: {
  e: Profile;
  email: string;
  saving: boolean;
  onSave: (id: string, patch: Partial<Profile>) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(e.full_name ?? "");
  const [phone, setPhone] = useState(e.phone ?? "");
  const [role, setRole] = useState(e.role);
  const [rate, setRate] = useState(e.hourly_rate?.toString() ?? "");
  const [active, setActive] = useState(e.active);
  const [panel, setPanel] = useState<"reinvite" | "offboard" | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Re-invite: Withers-time link always; tick which other systems to (re)invite to.
  const [reSystems, setReSystems] = useState<System[]>([]);
  // Offboard.
  const [lastDay, setLastDay] = useState("");
  const [reason, setReason] = useState<string>(OFFBOARD_REASONS[0]);
  const [reasonNote, setReasonNote] = useState("");
  const [finalPay, setFinalPay] = useState(FINAL_PAY_NOTE_DEFAULT);
  const [runNow, setRunNow] = useState(false);
  const [offSystems, setOffSystems] = useState<System[]>(SYSTEMS_DEFAULT);
  const [confirm, setConfirm] = useState(false);

  function openPanel(p: "reinvite" | "offboard") {
    setPanel((cur) => (cur === p ? null : p));
    setMsg(null);
    setErr(null);
    setConfirm(false);
  }

  async function reinvite() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const data = await post("/api/staffing", "POST", {
        kind: "reinvite",
        employee_id: e.id,
        legal_name: name.trim() || e.full_name,
        phone: phone || undefined,
        role,
        pay_rate: rate ? Number(rate) : undefined,
        systems: reSystems,
      });
      const rec = data.record as LifecycleWithSteps;
      const inv = rec.steps.find((st) => st.key === "withers_time_invite");
      if (inv?.status === "done") {
        setMsg(`Invite emailed to ${email}.` + (reSystems.length ? " Other systems queued; see the checklist below." : ""));
        setPanel(null);
      } else {
        setErr(inv?.result ?? "Invite failed.");
      }
      router.refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }

  async function offboard() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const data = await post("/api/staffing", "POST", {
        kind: "offboarding",
        employee_id: e.id,
        last_day: lastDay,
        reason,
        reason_note: reasonNote || undefined,
        final_pay_note: finalPay,
        systems: offSystems,
        run_now: runNow,
      });
      setMsg(
        data.ran
          ? "Login banned and access removed. The other systems are queued; final pay is on the checklist below."
          : "Recorded. Access removal waits for the last day; press Run on the record below that day.",
      );
      setPanel(null);
      setConfirm(false);
      router.refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }

  const rowCls = "bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-slate-900 dark:text-slate-100";

  return (
    <>
      <tr className="border-t border-slate-200 dark:border-slate-800">
        <td className="px-3 py-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">{email || "—"}</td>
        <td className="px-3 py-2">
          <input value={name} onChange={(ev) => setName(ev.target.value)} onBlur={() => onSave(e.id, { full_name: name })} className={`${rowCls} w-40`} />
          {e.active && !e.has_workforce && (
            <div className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5" title="Not payable until QuickBooks Workforce self-setup is finished">
              Workforce not finished
            </div>
          )}
        </td>
        <td className="px-3 py-2">
          <input value={phone} onChange={(ev) => setPhone(ev.target.value)} onBlur={() => onSave(e.id, { phone })} placeholder="+1215..." className={`${rowCls} w-32`} />
        </td>
        <td className="px-3 py-2">
          <select value={role} onChange={(ev) => { const r = ev.target.value as Profile["role"]; setRole(r); onSave(e.id, { role: r }); }} className={rowCls}>
            <option value="employee">employee</option>
            <option value="manager">manager</option>
          </select>
        </td>
        <td className="px-3 py-2 text-right">
          <input value={rate} onChange={(ev) => setRate(ev.target.value)} onBlur={() => onSave(e.id, { hourly_rate: rate ? Number(rate) : null })} className={`${rowCls} w-20 text-right`} />
        </td>
        <td className="px-3 py-2 text-center">
          <input type="checkbox" checked={active} onChange={(ev) => { setActive(ev.target.checked); onSave(e.id, { active: ev.target.checked }); }} />
        </td>
        <td className="px-3 py-2 align-top whitespace-nowrap">
          {email ? (
            <div className="flex gap-2">
              <button type="button" onClick={() => openPanel("reinvite")} disabled={busy || saving} className="text-xs text-slate-500 hover:text-emerald-500 disabled:opacity-50">
                Re-invite
              </button>
              <button type="button" onClick={() => openPanel("offboard")} disabled={busy || saving} className="text-xs text-slate-500 hover:text-rose-500 disabled:opacity-50">
                Offboard
              </button>
            </div>
          ) : null}
          {msg && <div className="text-[11px] text-emerald-500 mt-0.5 max-w-[240px] whitespace-normal">{msg}</div>}
          {err && !panel && <div className="text-[11px] text-rose-500 mt-0.5 max-w-[240px] whitespace-normal">{err}</div>}
        </td>
      </tr>
      {panel === "reinvite" && (
        <tr className="bg-slate-50 dark:bg-slate-900/60">
          <td colSpan={7} className="px-3 py-3">
            <div className="space-y-2">
              <div className="text-xs text-slate-600 dark:text-slate-400">
                Re-sends the Withers-time sign-in link to {email} (and reactivates them). Tick any other system to (re)invite them to; the worker does those.
              </div>
              <SystemPicker value={reSystems} onChange={setReSystems} verb="Also invite to" />
              {err && <div className="text-xs text-rose-500">{err}</div>}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setPanel(null)} className={quietBtn}>Cancel</button>
                <button type="button" onClick={reinvite} disabled={busy} className={primaryBtn}>{busy ? "Sending…" : "Send"}</button>
              </div>
            </div>
          </td>
        </tr>
      )}
      {panel === "offboard" && (
        <tr className="bg-slate-50 dark:bg-slate-900/60">
          <td colSpan={7} className="px-3 py-3">
            <div className="space-y-2">
              <div className="text-xs text-slate-600 dark:text-slate-400">
                Bans the login, signs them out everywhere, drops manager access, marks them inactive and frees the fob, in that order.
                The ticked systems are queued for the worker to deactivate (never delete). Account and time entries are kept.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <label className={fieldLabel}>Last day
                  <input type="date" value={lastDay} onChange={(ev) => setLastDay(ev.target.value)} className={field} />
                </label>
                <label className={fieldLabel}>Reason
                  <select value={reason} onChange={(ev) => setReason(ev.target.value)} className={field}>
                    {OFFBOARD_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </label>
                <label className={fieldLabel}>Note
                  <input value={reasonNote} onChange={(ev) => setReasonNote(ev.target.value)} className={field} placeholder="optional" />
                </label>
              </div>
              <label className={fieldLabel}>Final-pay note (goes on the checklist)
                <textarea rows={2} value={finalPay} onChange={(ev) => setFinalPay(ev.target.value)} className={field} />
              </label>
              <SystemPicker value={offSystems} onChange={setOffSystems} verb="Also remove from" />
              <label className="text-xs text-slate-700 dark:text-slate-300 flex items-center gap-2">
                <input type="checkbox" checked={runNow} onChange={(ev) => setRunNow(ev.target.checked)} />
                Remove access now even if the last day is still ahead
              </label>
              {err && <div className="text-xs text-rose-500">{err}</div>}
              <div className="flex gap-2 justify-end items-center">
                {confirm && <span className="text-xs text-rose-500">Offboard {name || email}? This bans their login.</span>}
                <button type="button" onClick={() => { setPanel(null); setConfirm(false); }} className={quietBtn}>Cancel</button>
                {!confirm ? (
                  <button type="button" onClick={() => setConfirm(true)} disabled={!lastDay} className={primaryBtn}>Offboard</button>
                ) : (
                  <button type="button" onClick={offboard} disabled={busy} className="text-xs rounded-md bg-rose-600 text-white font-medium px-3 py-1.5 hover:bg-rose-500 disabled:opacity-50">
                    {busy ? "Working…" : "Yes, offboard"}
                  </button>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function LocationSection({ locations }: { locations: Location[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function saveLoc(id: number, patch: Partial<Location>) {
    setBusy(true);
    await fetch(`/api/locations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setBusy(false);
    router.refresh();
  }

  function useMyLocation(id: number) {
    setMsg(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        saveLoc(id, { latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        setMsg("Set to your current location. Stand at the store when you do this.");
      },
      () => setMsg("Could not read your location."),
      { enableHighAccuracy: true },
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Locations &amp; geofence</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
        Clock-in is allowed only within the radius of the default location. Easiest: stand at the store, tap &ldquo;Use my location&rdquo;.
      </p>
      <div className="space-y-4">
        {locations.map((l) => (
          <LocationRow key={l.id} l={l} busy={busy} onSave={saveLoc} onUseMine={useMyLocation} />
        ))}
        {msg && <div className="text-sm text-emerald-400">{msg}</div>}
      </div>
    </section>
  );
}

function LocationRow({
  l,
  busy,
  onSave,
  onUseMine,
}: {
  l: Location;
  busy: boolean;
  onSave: (id: number, patch: Partial<Location>) => void;
  onUseMine: (id: number) => void;
}) {
  const [name, setName] = useState(l.name);
  const [lat, setLat] = useState(String(l.latitude));
  const [lng, setLng] = useState(String(l.longitude));
  const [radius, setRadius] = useState(String(l.radius_meters));

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => onSave(l.id, { name })} className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-slate-900 dark:text-slate-100 flex-1" />
        {l.is_default && <span className="text-xs text-emerald-400 border border-emerald-900 rounded px-2 py-0.5">default</span>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <label className="text-xs text-slate-600 dark:text-slate-400">Latitude
          <input value={lat} onChange={(e) => setLat(e.target.value)} onBlur={() => onSave(l.id, { latitude: Number(lat) })} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-slate-900 dark:text-slate-100" />
        </label>
        <label className="text-xs text-slate-600 dark:text-slate-400">Longitude
          <input value={lng} onChange={(e) => setLng(e.target.value)} onBlur={() => onSave(l.id, { longitude: Number(lng) })} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-slate-900 dark:text-slate-100" />
        </label>
        <label className="text-xs text-slate-600 dark:text-slate-400">Radius (m)
          <input value={radius} onChange={(e) => setRadius(e.target.value)} onBlur={() => onSave(l.id, { radius_meters: Number(radius) })} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-slate-900 dark:text-slate-100" />
        </label>
        <div className="flex items-end">
          <button onClick={() => onUseMine(l.id)} disabled={busy} className="w-full px-2 py-1.5 text-xs rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium hover:bg-slate-800 dark:hover:bg-white">Use my location</button>
        </div>
      </div>
    </div>
  );
}
