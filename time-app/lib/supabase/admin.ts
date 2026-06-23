import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client for trusted server contexts only (cron, privileged
// reads). Never import this into client components. Falls back to the anon
// key if the service role key is not set (reads will then obey RLS).
export function createAdminClient() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
