import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// POST /api/call-desk/prospects/:id/reopen
//
// Undo a "Not now / lost" (bj-finance #421): the prospect goes back to
// 'sequenced' and the desk offers their number again. Nothing about their
// email standing is touched here, because nothing about it was touched when
// they were marked lost either.
//
// The RPC refuses anything that is not currently 'called_lost' — in
// particular a 'suppressed' prospect can never be revived this way. A
// do-not-call request outlives every relationship and every mis-tap.
export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const prospectId = Number(params.id);
  if (!Number.isInteger(prospectId) || prospectId <= 0)
    return NextResponse.json({ error: "Bad prospect id" }, { status: 400 });

  const { error } = await supabase.rpc("call_desk_reopen", {
    p_prospect_id: prospectId,
  });
  if (error)
    return NextResponse.json({ error: error.message }, { status: 409 });

  return NextResponse.json({ ok: true, prospect_id: prospectId });
}
