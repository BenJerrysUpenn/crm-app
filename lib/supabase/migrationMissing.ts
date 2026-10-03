// One definition of "this failure is an un-applied migration, not a real
// fault" (CODING_STANDARDS.md:9 — one source of truth per fact). Until a human
// runs the relevant supabase/crm/*.sql, the outreach tables and the
// call_desk_queue view are unreachable to the signed-in manager; both the
// call-desk queue route and the Funnels route distinguish that case so the UI
// can render a "migration not applied" state instead of a scary generic
// failure. If either route learns a new code, it is added here once.
//
// Accepts either a Supabase/PostgREST error object (`{ code, message }`) or a
// thrown value, so a caller that destructures `error` and one that catches can
// share it.
export function isMigrationMissing(error: unknown): boolean {
  const e = error as { code?: string | null; message?: string } | null;
  const code = e?.code ?? null;
  const msg = e?.message ?? String(error ?? "");
  return (
    code === "42P01" || // undefined_table
    code === "42501" || // insufficient_privilege
    code === "PGRST205" || // PostgREST: table not in schema cache
    /does not exist|schema cache|permission denied/i.test(msg)
  );
}
