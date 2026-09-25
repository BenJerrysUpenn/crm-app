import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchExceptionQueue, fetchFunnelPayload, fetchLoopStatus, resolveWindow } from "@/lib/funnels/queries";

export const dynamic = "force-dynamic";

// GET /api/funnels?window=7|30|90|semester
//
// The whole tab's data in one call: loop status (panels 1+4), the funnel flow
// (panel 3) over the selected window, and the exception queue (panel 2). Runs
// as the signed-in manager; every table is RLS-gated exactly as the call desk.
//
// Freshness matters here (route-handler fetches are cached even under
// force-dynamic — crm-app PR #12), so this handler does no fetch() of its own;
// it reads Supabase directly and the browser fetches it with cache: 'no-store'.
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const windowKey = resolveWindow(req.nextUrl.searchParams.get("window"));
  const now = new Date();

  try {
    const [loop, funnel, exceptions] = await Promise.all([
      fetchLoopStatus(supabase, now),
      fetchFunnelPayload(supabase, windowKey, now),
      fetchExceptionQueue(supabase, now),
    ]);
    return NextResponse.json({ loop, funnel, exceptions });
  } catch (error: any) {
    // Until a human has run supabase/crm/001_call_desk.sql the outreach tables
    // are unreachable to the signed-in manager; distinguish that from a real
    // failure so the UI can explain it (same contract as the call-desk queue).
    const msg = error?.message ?? String(error);
    const code = error?.code ?? null;
    const missing =
      code === "42P01" ||
      code === "42501" ||
      code === "PGRST205" ||
      /does not exist|schema cache|permission denied/i.test(msg);
    return NextResponse.json(
      { error: msg, code, migration_missing: missing },
      { status: missing ? 503 : 500 },
    );
  }
}
