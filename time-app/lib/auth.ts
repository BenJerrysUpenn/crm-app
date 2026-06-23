import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";

// Returns the signed-in user's profile, or null if not signed in / no profile.
export async function getProfile(): Promise<Profile | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();
  return (data as Profile) ?? null;
}
