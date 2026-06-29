"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { CHANNELS, TYPES_BY_ROLE } from "@/lib/notifPrefs";
import type { Role } from "@/lib/types";

export default function AccountForm({
  initialName,
  initialPhone,
  profileId,
  role,
  initialPrefs,
}: {
  initialName: string;
  initialPhone: string;
  profileId: string;
  role: Role;
  initialPrefs: Record<string, boolean>;
}) {
  const router = useRouter();
  const supabase = createClient();

  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  // Notification preferences (absent key = on).
  const [prefs, setPrefs] = useState<Record<string, boolean>>(initialPrefs ?? {});
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsMsg, setPrefsMsg] = useState<string | null>(null);
  const isOn = (k: string) => prefs[k] !== false;
  function toggle(k: string) {
    setPrefs((p) => ({ ...p, [k]: !(p[k] !== false) }));
    setPrefsMsg(null);
  }
  async function savePrefs() {
    setSavingPrefs(true);
    setPrefsMsg(null);
    const { error } = await supabase
      .from("profiles")
      .update({ notif_prefs: prefs })
      .eq("id", profileId);
    setSavingPrefs(false);
    setPrefsMsg(error ? error.message : "Saved.");
  }

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    setProfileMsg(null);
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: name || null, phone: phone || null })
      .eq("id", profileId);
    setSavingProfile(false);
    setProfileMsg(error ? error.message : "Saved.");
    if (!error) router.refresh();
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwErr(null);
    setPwMsg(null);
    if (pw.length < 8) {
      setPwErr("Use at least 8 characters.");
      return;
    }
    if (pw !== pw2) {
      setPwErr("Passwords don't match.");
      return;
    }
    setSavingPw(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setSavingPw(false);
    if (error) {
      setPwErr(error.message);
      return;
    }
    setPw("");
    setPw2("");
    setPwMsg("Password updated. Use it next time you sign in.");
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">My account</h1>

      <form onSubmit={saveProfile} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
        <div className="text-sm font-medium text-slate-700 dark:text-slate-300">Profile</div>
        <label className="block text-xs text-slate-600 dark:text-slate-400">Name
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-slate-900 dark:text-slate-100" />
        </label>
        <label className="block text-xs text-slate-600 dark:text-slate-400">Phone (for text alerts)
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+12155551234" className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-slate-900 dark:text-slate-100" />
        </label>
        {profileMsg && <div className="text-sm text-emerald-400">{profileMsg}</div>}
        <button disabled={savingProfile} className="px-3 py-1.5 text-sm rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50">
          {savingProfile ? "Saving…" : "Save profile"}
        </button>
      </form>

      <form onSubmit={savePassword} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
        <div className="text-sm font-medium text-slate-700 dark:text-slate-300">Change password</div>
        <p className="text-xs text-slate-500">Set your own password. You won&apos;t need the temporary one again.</p>
        <label className="block text-xs text-slate-600 dark:text-slate-400">New password
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-slate-900 dark:text-slate-100" />
        </label>
        <label className="block text-xs text-slate-600 dark:text-slate-400">Confirm new password
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-slate-900 dark:text-slate-100" />
        </label>
        {pwErr && <div className="text-sm text-rose-300 bg-rose-950 border border-rose-900 rounded-md px-3 py-2">{pwErr}</div>}
        {pwMsg && <div className="text-sm text-emerald-400">{pwMsg}</div>}
        <button disabled={savingPw} className="px-3 py-1.5 text-sm rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-50">
          {savingPw ? "Updating…" : "Update password"}
        </button>
      </form>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
        <div className="text-sm font-medium text-slate-700 dark:text-slate-300">Notifications</div>

        <div>
          <div className="text-xs text-slate-600 dark:text-slate-400 mb-2">How to reach me</div>
          <div className="space-y-2">
            {CHANNELS.map((c) => (
              <Toggle key={c.key} label={c.label} on={isOn(c.key)} onToggle={() => toggle(c.key)} />
            ))}
          </div>
          <p className="text-[11px] text-slate-600 mt-2">In-app notifications always show in the bell.</p>
        </div>

        <div>
          <div className="text-xs text-slate-600 dark:text-slate-400 mb-2">Notify me about</div>
          <div className="space-y-2">
            {TYPES_BY_ROLE[role].map((t) => (
              <Toggle key={t.key} label={t.label} on={isOn(t.key)} onToggle={() => toggle(t.key)} />
            ))}
          </div>
        </div>

        {prefsMsg && <div className="text-sm text-emerald-400">{prefsMsg}</div>}
        <button onClick={savePrefs} disabled={savingPrefs} className="px-3 py-1.5 text-sm rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50">
          {savingPrefs ? "Saving…" : "Save notification settings"}
        </button>
      </div>
    </div>
  );
}

function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-3 text-left"
    >
      <span className="text-sm text-slate-700 dark:text-slate-300">{label}</span>
      <span
        className={`shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors ${
          on ? "bg-emerald-500" : "bg-slate-700"
        }`}
      >
        <span
          className={`block w-5 h-5 rounded-full bg-white transition-transform ${
            on ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}
