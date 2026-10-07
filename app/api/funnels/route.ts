import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchExceptionQueue, fetchFunnelPayload, fetchLoopStatus } from "@/lib/funnels/queries";
import { parseWindow } from "@/lib/funnels/windows";
import { readFailureResponse } from "@/lib/supabase/migrationMissing";

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

  const windowKey = parseWindow(req.nextUrl.searchParams.get("window"));
  const now = new Date();

  try {
    const [loop, funnel, exceptions] = await Promise.all([
      fetchLoopStatus(supabase, now),
      fetchFunnelPayload(supabase, windowKey, now),
      fetchExceptionQueue(supabase, now),
    ]);
    return NextResponse.json({ loop, funnel, exceptions });
  } catch (error) {
    // Until a human has run supabase/crm/001_call_desk.sql the outreach tables
    // are unreachable to the signed-in manager; the shared response tells that
    // apart from a real failure so the UI can explain it.
    return readFailureResponse(error);
  }
}
