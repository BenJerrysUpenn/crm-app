import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CallDeskRow } from "@/lib/callDesk/types";

export const dynamic = "force-dynamic";

// GET /api/call-desk/queue
//
// The call queue: warm-outreach prospects the engine recently mailed, not
// suppressed, with a phone number. Newest mail first — the view already
// orders; we don't re-sort here (the client floats pending dispositions to
// the top for display only).
//
// Runs as the signed-in user on purpose: `call_desk_queue` is
// security_invoker and the manager RLS policies from
// supabase/crm/001_call_desk.sql are what actually gate it. No admin client.
export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data, error } = await supabase.from("call_desk_queue").select("*");

  if (error) {
    // Until a human runs supabase/crm/001_call_desk.sql the view does not
    // exist / is not reachable. Say so with a distinguishable code so the
    // UI can render the "migration not applied" state instead of a scary
    // generic failure.
    const missing =
      error.code === "42P01" || // undefined_table
      error.code === "42501" || // insufficient_privilege
      error.code === "PGRST205" || // PostgREST: table not in schema cache
      /does not exist|schema cache|permission denied/i.test(error.message);
    return NextResponse.json(
      {
        error: error.message,
        code: error.code ?? null,
        migration_missing: missing,
      },
      { status: missing ? 503 : 500 },
    );
  }

  return NextResponse.json({ rows: (data ?? []) as CallDeskRow[] });
}
