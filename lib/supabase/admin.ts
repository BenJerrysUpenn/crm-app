import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client for trusted SERVER contexts only (route handlers,
// privileged writes that must bypass RLS — e.g. creating time-app shifts from
// a catering stage change). Never import this into a client component.
//
// Falls back to the anon key if the service role key is not set, in which case
// writes will obey RLS and privileged operations will fail closed.
export function createAdminClient() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
