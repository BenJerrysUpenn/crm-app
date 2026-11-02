import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CallDeskRow } from "@/lib/callDesk/types";
import { readFailureResponse } from "@/lib/supabase/migrationMissing";

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

  // Until a human runs supabase/crm/001_call_desk.sql the view does not
  // exist / is not reachable; the shared response says so with a
  // distinguishable code so the UI can render the "migration not applied"
  // state instead of a scary generic failure.
  if (error) return readFailureResponse(error);

  return NextResponse.json({ rows: (data ?? []) as CallDeskRow[] });
}
