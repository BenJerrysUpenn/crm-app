import { NextResponse } from "next/server";

// One definition of "this failure is an un-applied migration, not a real
// fault" and of how a route reports it (CODING_STANDARDS.md:9 — one source of
// truth per fact). Until a human runs the relevant supabase/crm/*.sql, the
// outreach tables and the call_desk_queue view are unreachable to the
// signed-in manager; both the call-desk queue route and the Funnels route
// answer that case with 503 and `migration_missing: true`, so the UI can render
// a "migration not applied" state instead of a scary generic failure, and any
// other failure with 500. If either route learns a new code, it is added here
// once.
function isMigrationMissing(error: unknown): boolean {
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

// The read-failure response. Accepts either a Supabase/PostgREST error object
// (`{ code, message }`) or a thrown value, so a caller that destructures
// `error` and one that catches can share it.
export function readFailureResponse(error: unknown): NextResponse {
  const e = error as { code?: string | null; message?: string } | null;
  const missing = isMigrationMissing(error);
  return NextResponse.json(
    {
      error: e?.message ?? String(error),
      code: e?.code ?? null,
      migration_missing: missing,
    },
    { status: missing ? 503 : 500 },
  );
}
