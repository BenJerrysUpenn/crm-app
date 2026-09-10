import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client for trusted server contexts only (cron, privileged
// reads). Never import this into client components. Falls back to the anon
// key if the service role key is not set (reads will then obey RLS).
//
// Every read goes out with `cache: "no-store"`. Next 14 patches global fetch
// and, inside a route handler, caches any GET that doesn't say otherwise for a
// year — `export const dynamic = "force-dynamic"` does not turn that off (it
// only marks the route dynamic; see next/dist/server/lib/patch-fetch.js, the
// "auto cache" branch). That bit the missed-clock-in cron: the URL asking
// "has this person clocked in for their 10am shift?" is the same on every run,
// so the first "no" was served back for the rest of the day and people who
// clocked in a few minutes late were still reported as missing. Anything read
// through this client is live data by definition, so none of it is cacheable.
function noStoreFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, cache: "no-store" });
}

export function createAdminClient() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: noStoreFetch },
  });
}
