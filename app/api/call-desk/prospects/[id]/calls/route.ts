import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CalledDetail } from "@/lib/callDesk/types";

export const dynamic = "force-dynamic";

// POST /api/call-desk/prospects/:id/calls
//
// "Call now" was tapped. Log the call immediately, before the caller leaves
// for the Phone app — the disposition arrives later via PATCH
// /api/call-desk/calls/:eventId. A row with disposition: null is a *pending*
// disposition; call_desk_queue surfaces it as pending_disposition_event_id
// and the UI nags until it is resolved.
//
// occurred_at is left to the column default (now()), which is what the
// contract means by "when Call now was tapped".
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

  const detail: CalledDetail = {
    by: user.email ?? "unknown",
    via: "call_desk",
    started_at: new Date().toISOString(),
    disposition: null,
  };

  const { data, error } = await supabase
    .from("outreach_events")
    .insert({ prospect_id: prospectId, event: "called", detail })
    .select("id")
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ event_id: data.id });
}
