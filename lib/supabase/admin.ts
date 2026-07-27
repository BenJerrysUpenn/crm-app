import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client for trusted SERVER contexts only (route handlers,
// privileged writes that must bypass RLS — e.g. creating time-app shifts from
// a catering stage change). Never import this into a client component.
//
// Requires SUPABASE_SERVICE_ROLE_KEY. This used to fall back to the anon key,
// on the theory that privileged work would then fail closed under RLS — but it
// failed OPEN instead: reads came back empty while writes still went through,
// so the catering reconciler's "do these shifts already exist?" check silently
// answered no and duplicated a deal's shifts on every run. Missing config must
// be loud, not a silent downgrade to a weaker identity.
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key)
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set; refusing to fall back to the anon key",
    );
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
