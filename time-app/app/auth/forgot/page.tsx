"use client";

import { useState } from "react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const res = await fetch("/api/auth/forgot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setErr(b.error ?? "Something went wrong. Try again.");
      return;
    }
    setDone(true);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-950 px-4">
      <form onSubmit={submit} className="bg-white dark:bg-slate-900 rounded-lg shadow-xl p-8 w-full max-w-sm space-y-4 border border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Reset your password</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Enter the email you use for Withers Time and we&apos;ll send a link to choose a new password.
          </p>
        </div>
        {done ? (
          <div className="text-sm text-emerald-400">
            If that email has an account, a reset link is on its way. It works once and expires after about an hour.
          </div>
        ) : (
          <>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
              Email
              <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500" />
            </label>
            {err && <div className="text-sm text-rose-300 bg-rose-950 border border-rose-900 rounded-md px-3 py-2">{err}</div>}
            <button type="submit" disabled={busy} className="w-full bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded-md py-2 font-medium hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50">
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </>
        )}
        <a href="/login" className="block text-sm text-slate-600 dark:text-slate-400 underline">Back to sign in</a>
      </form>
    </div>
  );
}
