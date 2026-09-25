import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// POST /api/funnels/suppress  { prospect_id: number }
//
// The one write this tab makes, and it deliberately reuses an EXISTING path:
// the call desk's `call_desk_do_not_call` RPC (supabase/crm/001_call_desk.sql),
// which writes the suppression row / status / event in one transaction, the
// same shape outreach/bounce_reader.py writes for an opt-out. The supervision
// view invents no new write — suppressing a replied prospect from the exception
// queue is exactly a manual do-not-call. Runs as the signed-in manager; the
// RPC is SECURITY INVOKER, so the manager RLS policies gate it.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { prospect_id?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const prospectId = Number(body.prospect_id);
  if (!Number.isInteger(prospectId) || prospectId <= 0) {
    return NextResponse.json({ error: "prospect_id required" }, { status: 400 });
  }

  const { error } = await supabase.rpc("call_desk_do_not_call", {
    p_prospect_id: prospectId,
    p_call_event_id: null,
  });
  if (error) {
    return NextResponse.json(
      { error: error.message, code: error.code ?? null },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
