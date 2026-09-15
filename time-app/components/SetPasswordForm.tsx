"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const input =
  "mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500";

export default function SetPasswordForm({ name, email }: { name: string | null; email: string }) {
  const router = useRouter();
  const supabase = createClient();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (pw.length < 8) {
      setErr("Use at least 8 characters.");
      return;
    }
    if (pw !== pw2) {
      setErr("Passwords don't match.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  const first = name ? name.split(" ")[0] : null;
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {first ? `Welcome, ${first}` : "Welcome"}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          Choose a password for Withers Time. You&apos;ll sign in with <span className="font-medium">{email}</span>.
        </p>
      </div>
      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
        Password
        <input type="password" required autoFocus autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className={input} />
      </label>
      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
        Confirm password
        <input type="password" required autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} className={input} />
      </label>
      {err && <div className="text-sm text-rose-300 bg-rose-950 border border-rose-900 rounded-md px-3 py-2">{err}</div>}
      <button type="submit" disabled={busy} className="w-full bg-emerald-500 text-slate-950 rounded-md py-2 font-medium hover:bg-emerald-400 disabled:opacity-50">
        {busy ? "Saving…" : "Save password and continue"}
      </button>
    </form>
  );
}
