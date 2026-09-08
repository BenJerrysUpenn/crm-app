import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SetPasswordForm from "@/components/SetPasswordForm";

export const dynamic = "force-dynamic";

// Where invite, magic-link and password-reset links end up: the person is
// already signed in (cookies written by /auth/confirm or /auth/callback) and
// just needs to choose a password.
export default async function SetPasswordPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?error=session");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-950 px-4">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl p-8 w-full max-w-sm border border-slate-200 dark:border-slate-800">
        <SetPasswordForm name={profile?.full_name ?? null} email={user.email ?? ""} />
      </div>
    </div>
  );
}
