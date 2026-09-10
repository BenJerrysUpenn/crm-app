import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { BLOCK_EXPLANATION, callBlockReason } from "@/lib/callDesk/compliance";
import type { CallDeskRow, CalledDetail } from "@/lib/callDesk/types";

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
//
// Before any of that: the lawful-dial gate (bj-finance #420). The rules live
// in lib/callDesk/compliance.ts and the UI greys the button with the same
// ones, but the UI is not the gate — a stale tab, a second device or a
// hand-edited request all reach here, so the row is re-read from
// `call_desk_queue` and judged server-side. A blocked call is refused with
// 409 and a `block_reason` the client can render.
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

  // The row as the database sees it, not as the client claims it is.
  const { data: queueRow, error: queueErr } = await supabase
    .from("call_desk_queue")
    .select("*")
    .eq("prospect_id", prospectId)
    .maybeSingle();

  if (queueErr)
    return NextResponse.json({ error: queueErr.message }, { status: 500 });
  if (!queueRow)
    return NextResponse.json(
      {
        error:
          "This prospect is not in the call queue — they may be suppressed or on the do-not-call list.",
        block_reason: "phone_suppressed",
      },
      { status: 409 },
    );

  const row = queueRow as CallDeskRow;
  const now = new Date();
  const blocked = callBlockReason(row, now);

  // callBlockReason already lets an out-of-window number through when it has
  // been scrubbed against the registries and came back clear inside the last
  // 31 days (hasFreshScrub) — that is what turns a stale warm number into a
  // lawful cold call. Everything it does return is final here, except
  // 'pending_outcome', which the #413 check below answers in its own shape.
  if (blocked && blocked !== "pending_outcome")
    return NextResponse.json(
      { error: BLOCK_EXPLANATION[blocked], block_reason: blocked },
      { status: 409 },
    );

  // One open call at a time (bj-finance #413). A second tap while the first
  // has no outcome is a mis-tap, not a second call — Alina made exactly that
  // mistake 13 seconds apart on first live use. The card disables Call now,
  // but a stale tab wouldn't know, so the rule is enforced here too.
  const { data: open, error: openErr } = await supabase
    .from("outreach_events")
    .select("id, detail")
    .eq("prospect_id", prospectId)
    .eq("event", "called")
    .order("id", { ascending: false })
    .limit(50);

  if (openErr)
    return NextResponse.json({ error: openErr.message }, { status: 500 });

  const pending = (open ?? []).find(
    (e) => !((e.detail ?? {}) as Partial<CalledDetail>).disposition,
  );
  if (pending)
    return NextResponse.json(
      {
        error: "Log the outcome of the last call first",
        pending_event_id: pending.id,
      },
      { status: 409 },
    );

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
