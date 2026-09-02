"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Landing page for links Supabase itself sends (dashboard "Invite user",
// "Send password recovery", or the no-Resend fallback in lib/authLinks.ts).
// Supabase redirects here with either ?code=... (PKCE) or
// #access_token=...&refresh_token=... (implicit). Either way we turn it into
// a session and continue to the set-password page.
//
// Requires Supabase Auth -> URL Configuration to allow this URL as a redirect.
export default function AuthCallbackPage() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const query = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const desc = hash.get("error_description") || query.get("error_description");
    if (desc) {
      setErr(desc);
      return;
    }
    let cancelled = false;
    (async () => {
      const code = query.get("code");
      const access_token = hash.get("access_token");
      const refresh_token = hash.get("refresh_token");
      let error: { message: string } | null = null;
      if (code) {
        ({ error } = await supabase.auth.exchangeCodeForSession(code));
      } else if (access_token && refresh_token) {
        ({ error } = await supabase.auth.setSession({ access_token, refresh_token }));
      } else {
        const { data } = await supabase.auth.getSession();
        if (!data.session) error = { message: "This link is invalid or has expired." };
      }
      if (cancelled) return;
      if (error) {
        setErr(error.message);
        return;
      }
      router.replace("/auth/set-password");
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-950 px-4">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl p-8 w-full max-w-sm space-y-3 border border-slate-200 dark:border-slate-800">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Withers Time</h1>
        {err ? (
          <>
            <div className="text-sm text-rose-300 bg-rose-950 border border-rose-900 rounded-md px-3 py-2">{err}</div>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Ask your manager to resend the invite from the Team page, or{" "}
              <a href="/auth/forgot" className="underline">request a password reset</a>.
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-400">Signing you in…</p>
        )}
      </div>
    </div>
  );
}
