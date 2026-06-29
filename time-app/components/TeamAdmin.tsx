"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Profile, Location, ShiftType } from "@/lib/types";
import type { AppSettings } from "@/lib/settings";

export default function TeamAdmin({
  employees,
  locations,
  emailById,
  settings,
  shiftTypes,
}: {
  employees: Profile[];
  locations: Location[];
  emailById: Record<string, string>;
  settings: AppSettings;
  shiftTypes: ShiftType[];
}) {
  const router = useRouter();
  const [savingId, setSavingId] = useState<string | null>(null);

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

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Team</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
          Add people under Supabase → Authentication → Users (Auto Confirm on). They appear here automatically. Set their role, phone (for SMS), and pay rate.
        </p>
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
  return (
    <div className="flex items-center gap-2">
      <input type="color" value={color} onChange={(e) => { setColor(e.target.value); onSave(t.id, { color: e.target.value }); }} className="w-9 h-9 rounded bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700" />
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== t.name && onSave(t.id, { name })} className="flex-1 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-slate-900 dark:text-slate-100 text-sm" />
      <button onClick={() => onRemove(t.id)} className="text-xs text-slate-500 hover:text-rose-400 px-2">Remove</button>
    </div>
  );
}

function SettingsSection({ settings }: { settings: AppSettings }) {
  const [empGrace, setEmpGrace] = useState(String(settings.employee_clockin_grace_min));
  const [mgrGrace, setMgrGrace] = useState(String(settings.manager_clockin_grace_min));
  const [tardy, setTardy] = useState(String(settings.tardy_grace_min));
  const [reminder, setReminder] = useState(String(settings.shift_reminder_lead_min));
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
  const [name, setName] = useState(e.full_name ?? "");
  const [phone, setPhone] = useState(e.phone ?? "");
  const [role, setRole] = useState(e.role);
  const [rate, setRate] = useState(e.hourly_rate?.toString() ?? "");
  const [active, setActive] = useState(e.active);

  return (
    <tr className="border-t border-slate-200 dark:border-slate-800">
      <td className="px-3 py-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">{email || "—"}</td>
      <td className="px-3 py-2">
        <input value={name} onChange={(ev) => setName(ev.target.value)} onBlur={() => onSave(e.id, { full_name: name })} className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-slate-900 dark:text-slate-100 w-40" />
      </td>
      <td className="px-3 py-2">
        <input value={phone} onChange={(ev) => setPhone(ev.target.value)} onBlur={() => onSave(e.id, { phone })} placeholder="+1215..." className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-slate-900 dark:text-slate-100 w-32" />
      </td>
      <td className="px-3 py-2">
        <select value={role} onChange={(ev) => { const r = ev.target.value as Profile["role"]; setRole(r); onSave(e.id, { role: r }); }} className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-slate-900 dark:text-slate-100">
          <option value="employee">employee</option>
          <option value="manager">manager</option>
        </select>
      </td>
      <td className="px-3 py-2 text-right">
        <input value={rate} onChange={(ev) => setRate(ev.target.value)} onBlur={() => onSave(e.id, { hourly_rate: rate ? Number(rate) : null })} className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-slate-900 dark:text-slate-100 w-20 text-right" />
      </td>
      <td className="px-3 py-2 text-center">
        <input type="checkbox" checked={active} onChange={(ev) => { setActive(ev.target.checked); onSave(e.id, { active: ev.target.checked }); }} />
      </td>
    </tr>
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
