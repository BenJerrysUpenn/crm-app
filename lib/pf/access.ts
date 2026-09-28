import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isOwnerRole } from "@/lib/roles";

// The page-level half of the owner-only rule for the personal-finance pages.
// The middleware refuses non-owners first (lib/supabase/middleware.ts); this
// is the second line, because the CRM's Next.js predates the fix for a
// middleware bypass (audit M5) and the feed is the owners' household finances.
//
// Call it before loadPfData(). It returns the signed-in owner's email, or
// never returns: no session goes to /login, anyone else to /no-access.
export async function requirePfOwner(): Promise<{ email: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!isOwnerRole(profile?.role)) redirect("/no-access");

  return { email: user.email ?? "" };
}
