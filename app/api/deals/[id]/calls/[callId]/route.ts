import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseCalledAt } from "@/lib/callLog";

// PATCH /api/deals/:id/calls/:callId
//
// Update a specific call_logs entry (called_at and/or notes). The drawer sends
// called_at only when the caller changed it, so an untouched time is never
// rewritten. We do NOT
// try to keep the appended line in deals.notes in sync — that field is
// an append-only activity log; the structured entry in the Calls
// section is the source of truth for current call details.
export async function PATCH(
  request: Request,
  { params }: { params: { id: string; callId: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const dealId = Number(params.id);
  const callId = Number(params.callId);
  if (!Number.isFinite(dealId) || !Number.isFinite(callId))
    return NextResponse.json({ error: "Bad id" }, { status: 400 });

  let body: { called_at?: string; notes?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const updates: Record<string, string> = {};
  if (typeof body.called_at === "string" && body.called_at.trim()) {
    // Eastern wall-clock time from the form; see lib/callLog.ts.
    const parsed = parseCalledAt(body.called_at);
    if (!parsed)
      return NextResponse.json(
        { error: `called_at invalid: ${body.called_at}` },
        { status: 400 },
      );
    updates.called_at = parsed.stored;
  }
  if (typeof body.notes === "string") {
    const trimmed = body.notes.trim();
    if (!trimmed)
      return NextResponse.json({ error: "notes cannot be empty" }, { status: 400 });
    updates.notes = trimmed;
  }
  if (Object.keys(updates).length === 0)
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("call_logs")
    .update(updates)
    .eq("id", callId)
    .eq("deal_id", dealId)
    .select("id, called_at, notes, created_by, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, call_log: data });
}

// DELETE /api/deals/:id/calls/:callId
//
// Remove a call_logs entry. deals.notes activity log line is left
// in place (audit trail).
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string; callId: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const dealId = Number(params.id);
  const callId = Number(params.callId);
  if (!Number.isFinite(dealId) || !Number.isFinite(callId))
    return NextResponse.json({ error: "Bad id" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("call_logs")
    .delete()
    .eq("id", callId)
    .eq("deal_id", dealId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
