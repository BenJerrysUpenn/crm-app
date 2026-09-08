"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Read ?error= straight off the URL. useSearchParams would force this page
  // into a Suspense boundary and break the static build.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code === "link")
      setNotice(
        "That link is invalid or has expired. Ask your manager to resend it, or reset your password.",
      );
    else if (code === "session")
      setNotice(
        "Your sign-in link didn't complete. Ask your manager to resend it, or reset your password.",
      );
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-950 px-4">
      <form
        onSubmit={handleSubmit}
        className="bg-white dark:bg-slate-900 rounded-lg shadow-xl p-8 w-full max-w-sm space-y-4 border border-slate-200 dark:border-slate-800"
      >
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Withers Time</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Sign in to clock in.</p>
        </div>
        {notice && (
          <div className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-900 rounded-md px-3 py-2">
            {notice}
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Email</label>
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500"
          />
        </div>
        {error && (
          <div className="text-sm text-rose-300 bg-rose-950 border border-rose-900 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded-md py-2 font-medium hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
        <a
          href="/auth/forgot"
          className="block text-center text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 underline"
        >
          Forgot password?
        </a>
      </form>
    </div>
  );
}
