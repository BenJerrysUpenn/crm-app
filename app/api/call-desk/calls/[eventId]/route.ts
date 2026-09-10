import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { buildStagePatch, writeStageChange } from "@/lib/dealUpdate";
import { isDisposition, type CalledDetail } from "@/lib/callDesk/types";

export const dynamic = "force-dynamic";

const MAX_NOTE = 4000;

const ALLOWED_KEYS = [
  "disposition",
  "duration_seconds",
  "note",
  "recording_path",
  "consent_confirmed",
  "close_deal_id",
] as const;

/** Stages a deal can still be lost from. Anything else is already decided. */
const OPEN_STAGES = ["Open", "Sent Quote", "Quote Review"];

type PatchBody = {
  disposition?: string;
  duration_seconds?: number;
  note?: string;
  recording_path?: string;
  consent_confirmed?: boolean;
};

// PATCH /api/call-desk/calls/:eventId
//
// Resolve (or amend) a logged call. Merges the given keys into the event's
// `detail` JSON — read-modify-write, because PostgREST cannot do `detail ||
// patch` in a plain UPDATE and the row is small. Side effects, in order:
//   note              -> also appended to the prospect's notes (RPC)
//   'do_not_call'     -> suppression (email AND phone) + status + 'suppressed'
//                        event (RPC), which drops the prospect from the queue.
//   'lost'            -> status 'called_lost' + notes line + 'lost' event
//                        (RPC), and, when close_deal_id is given, that deal
//                        moves to Closed Lost. Nothing touches suppression or
//                        marketing_opt_in: they stay on the email list
//                        (bj-finance #421).
//
// The event write lands first: if a side-effect RPC fails, the disposition
// is still recorded rather than the call staying silently pending.
export async function PATCH(
  request: Request,
  { params }: { params: { eventId: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const eventId = Number(params.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0)
    return NextResponse.json({ error: "Bad event id" }, { status: 400 });

  let raw: Record<string, unknown>;
  try {
    raw = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });

  // --- validate: only the allowed keys, each with the right shape ---------
  const unknownKeys = Object.keys(raw).filter(
    (k) => !(ALLOWED_KEYS as readonly string[]).includes(k),
  );
  if (unknownKeys.length)
    return NextResponse.json(
      { error: `Unsupported field(s): ${unknownKeys.join(", ")}` },
      { status: 400 },
    );

  const patch: PatchBody = {};

  if (raw.disposition !== undefined && raw.disposition !== null) {
    if (!isDisposition(raw.disposition))
      return NextResponse.json(
        {
          error:
            "disposition must be one of no_answer, voicemail, spoke, interested, lost, do_not_call",
        },
        { status: 400 },
      );
    patch.disposition = raw.disposition;
  }

  if (raw.duration_seconds !== undefined && raw.duration_seconds !== null) {
    const n = raw.duration_seconds;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
      return NextResponse.json(
        { error: "duration_seconds must be a non-negative integer" },
        { status: 400 },
      );
    patch.duration_seconds = n;
  }

  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== "string")
      return NextResponse.json({ error: "note must be a string" }, { status: 400 });
    if (raw.note.length > MAX_NOTE)
      return NextResponse.json(
        { error: `note must be ${MAX_NOTE} characters or fewer` },
        { status: 400 },
      );
    const trimmed = raw.note.trim();
    if (trimmed) patch.note = trimmed;
  }

  if (raw.recording_path !== undefined && raw.recording_path !== null) {
    if (typeof raw.recording_path !== "string" || !raw.recording_path.trim())
      return NextResponse.json(
        { error: "recording_path must be a non-empty string" },
        { status: 400 },
      );
    patch.recording_path = raw.recording_path.trim();
  }

  // Not part of `patch`: it is an instruction about a different table, not a
  // field of this call's detail.
  let closeDealId: number | null = null;
  if (raw.close_deal_id !== undefined && raw.close_deal_id !== null) {
    const n = raw.close_deal_id;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0)
      return NextResponse.json(
        { error: "close_deal_id must be a positive integer" },
        { status: 400 },
      );
    if (raw.disposition !== "lost")
      return NextResponse.json(
        { error: "close_deal_id only applies to the 'lost' outcome" },
        { status: 400 },
      );
    closeDealId = n;
  }

  if (raw.consent_confirmed !== undefined && raw.consent_confirmed !== null) {
    if (typeof raw.consent_confirmed !== "boolean")
      return NextResponse.json(
        { error: "consent_confirmed must be a boolean" },
        { status: 400 },
      );
    patch.consent_confirmed = raw.consent_confirmed;
  }

  if (!Object.keys(patch).length)
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  // --- read the current row ----------------------------------------------
  const { data: row, error: readErr } = await supabase
    .from("outreach_events")
    .select("id, prospect_id, event, detail")
    .eq("id", eventId)
    .maybeSingle();

  if (readErr)
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Call not found" }, { status: 404 });
  if (row.event !== "called")
    return NextResponse.json(
      { error: `Event ${eventId} is '${row.event}', not a call` },
      { status: 409 },
    );

  const existing = (row.detail ?? {}) as Partial<CalledDetail>;
  const now = new Date().toISOString();

  const detail: CalledDetail = {
    ...existing,
    ...patch,
    by: existing.by ?? user.email ?? "unknown",
    via: "call_desk",
    started_at: existing.started_at ?? now,
    disposition:
      (patch.disposition as CalledDetail["disposition"]) ??
      existing.disposition ??
      null,
  };

  // Stamp when the outcome was recorded (re-stamped if it is corrected).
  if (patch.disposition) detail.dispositioned_at = now;

  if (patch.recording_path) detail.recording_uploaded_at = now;

  const { error: updErr } = await supabase
    .from("outreach_events")
    .update({ detail })
    .eq("id", eventId);
  if (updErr)
    return NextResponse.json({ error: updErr.message }, { status: 500 });

  // --- side effects -------------------------------------------------------
  if (patch.note) {
    const { error: noteErr } = await supabase.rpc("call_desk_append_note", {
      p_prospect_id: row.prospect_id,
      p_text: patch.note,
    });
    if (noteErr)
      return NextResponse.json(
        { error: `Call saved, but the note failed: ${noteErr.message}` },
        { status: 500 },
      );
  }

  // "Not now / lost (keep emailing)" — bj-finance #421.
  if (patch.disposition === "lost") {
    const { error: lostErr } = await supabase.rpc("call_desk_mark_lost", {
      p_prospect_id: row.prospect_id,
      p_call_event_id: eventId,
      p_deal_id: closeDealId,
    });
    if (lostErr)
      return NextResponse.json(
        { error: `Call saved, but marking them lost failed: ${lostErr.message}` },
        { status: 500 },
      );

    if (closeDealId !== null) {
      // Through the CRM's own stage-change path (lib/dealUpdate.ts), the same
      // one the Kanban board and the calendar use, so boomerang_reason and
      // is_active land the way Catering-Manager's automation expects. Never a
      // raw stage write.
      const { data: deal, error: dealErr } = await supabase
        .from("deals")
        .select("id, stage, payment_status, contact_email")
        .eq("id", closeDealId)
        .maybeSingle();

      if (dealErr)
        return NextResponse.json(
          { error: `Call saved, but the deal read failed: ${dealErr.message}` },
          { status: 500 },
        );
      if (!deal)
        return NextResponse.json(
          { error: `Call saved, but deal ${closeDealId} was not found.` },
          { status: 404 },
        );

      // The deal must actually belong to this prospect, and must still be
      // open. Neither is something a client gets to assert.
      const { data: prospect } = await supabase
        .from("outreach_prospects")
        .select("email")
        .eq("id", row.prospect_id)
        .maybeSingle();
      const dealEmail = (deal.contact_email ?? "").trim().toLowerCase();
      const prospectEmail = (prospect?.email ?? "").trim().toLowerCase();
      if (!dealEmail || dealEmail !== prospectEmail)
        return NextResponse.json(
          {
            error: `Call saved, but deal ${closeDealId} does not belong to this prospect.`,
          },
          { status: 409 },
        );
      if (!OPEN_STAGES.includes(deal.stage))
        return NextResponse.json(
          {
            error: `Call saved, but deal ${closeDealId} is already "${deal.stage}".`,
          },
          { status: 409 },
        );

      const stagePatch = buildStagePatch("Closed Lost", deal.payment_status);
      const { error: stageErr } = await writeStageChange(
        supabase,
        closeDealId,
        stagePatch,
      );
      if (stageErr)
        return NextResponse.json(
          {
            error: `Call saved and marked lost, but closing deal ${closeDealId} failed: ${stageErr.message}`,
          },
          { status: 500 },
        );
    }
  }

  if (patch.disposition === "do_not_call") {
    const { error: dncErr } = await supabase.rpc("call_desk_do_not_call", {
      p_prospect_id: row.prospect_id,
      p_call_event_id: eventId,
    });
    if (dncErr)
      return NextResponse.json(
        {
          error: `Call saved, but do-not-call suppression failed: ${dncErr.message}`,
        },
        { status: 500 },
      );
  }

  return NextResponse.json({ ok: true, detail, closed_deal_id: closeDealId });
}

// DELETE /api/call-desk/calls/:eventId
//
// Undo a mis-tapped "Call now" (bj-finance #413). A call that was never made
// is worse than no record: it inflates the calls count and leaves a pending
// disposition that can never be answered honestly. So the row goes away —
// but only while it is still empty. Once an outcome or a recording is on it,
// the call is history and history is not edited here.
export async function DELETE(
  _request: Request,
  { params }: { params: { eventId: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const eventId = Number(params.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0)
    return NextResponse.json({ error: "Bad event id" }, { status: 400 });

  // Read as the signed-in user: RLS decides whether they may see this row at
  // all, so the checks below run on a row they are entitled to.
  const { data: row, error: readErr } = await supabase
    .from("outreach_events")
    .select("id, event, detail")
    .eq("id", eventId)
    .maybeSingle();

  if (readErr)
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Call not found" }, { status: 404 });
  if (row.event !== "called")
    return NextResponse.json(
      { error: `Event ${eventId} is '${row.event}', not a call` },
      { status: 409 },
    );

  const detail = (row.detail ?? {}) as Partial<CalledDetail>;
  if (detail.disposition)
    return NextResponse.json(
      { error: "This call already has an outcome, so it can't be removed." },
      { status: 409 },
    );
  if (detail.recording_path)
    return NextResponse.json(
      { error: "This call has a recording attached, so it can't be removed." },
      { status: 409 },
    );

  // Managers hold SELECT/INSERT/UPDATE on outreach_events (supabase/crm/
  // 001_call_desk.sql) and nothing else — the user-scoped client physically
  // cannot delete. Rather than widen the grant with a migration, the one
  // DELETE statement runs service-role, reached only after the sign-in check
  // and all three row checks above have passed. Nothing else on this route
  // uses the admin client.
  const admin = createAdminClient();
  const { error: delErr } = await admin
    .from("outreach_events")
    .delete()
    .eq("id", eventId)
    .eq("event", "called");
  if (delErr)
    return NextResponse.json({ error: delErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, deleted: eventId });
}
