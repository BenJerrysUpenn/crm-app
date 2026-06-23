"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function AccountForm({
  initialName,
  initialPhone,
  profileId,
}: {
  initialName: string;
  initialPhone: string;
  profileId: string;
}) {
  const router = useRouter();
  const supabase = createClient();

  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

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
      <h1 className="text-lg font-semibold text-slate-100">My account</h1>

      <form onSubmit={saveProfile} className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
        <div className="text-sm font-medium text-slate-300">Profile</div>
        <label className="block text-xs text-slate-400">Name
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-slate-100" />
        </label>
        <label className="block text-xs text-slate-400">Phone (for text alerts)
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+12155551234" className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-slate-100" />
        </label>
        {profileMsg && <div className="text-sm text-emerald-400">{profileMsg}</div>}
        <button disabled={savingProfile} className="px-3 py-1.5 text-sm rounded-md bg-slate-100 text-slate-900 font-medium hover:bg-white disabled:opacity-50">
          {savingProfile ? "Saving…" : "Save profile"}
        </button>
      </form>

      <form onSubmit={savePassword} className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
        <div className="text-sm font-medium text-slate-300">Change password</div>
        <p className="text-xs text-slate-500">Set your own password. You won&apos;t need the temporary one again.</p>
        <label className="block text-xs text-slate-400">New password
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-slate-100" />
        </label>
        <label className="block text-xs text-slate-400">Confirm new password
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-slate-100" />
        </label>
        {pwErr && <div className="text-sm text-rose-300 bg-rose-950 border border-rose-900 rounded-md px-3 py-2">{pwErr}</div>}
        {pwMsg && <div className="text-sm text-emerald-400">{pwMsg}</div>}
        <button disabled={savingPw} className="px-3 py-1.5 text-sm rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-50">
          {savingPw ? "Updating…" : "Update password"}
        </button>
      </form>
    </div>
  );
}
