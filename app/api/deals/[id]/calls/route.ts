import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/deals/:id/calls
//
// List all call_logs entries for a deal, newest first. Used by the
// drawer's Calls section to render the structured list.
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const dealId = Number(params.id);
  if (!Number.isFinite(dealId))
    return NextResponse.json({ error: "Bad deal id" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("call_logs")
    .select("id, called_at, notes, created_by, created_at")
    .eq("deal_id", dealId)
    .order("called_at", { ascending: false });
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ calls: data ?? [] });
}

// POST /api/deals/:id/calls
//
// Log a phone call against a deal. Body: { called_at: ISO string, notes: string }.
// Writes a structured row to call_logs AND appends a human-readable entry to
// deals.notes (the activity log column shown in the drawer) so the crew sees
// the call in the running log without a separate view.
//
// Uses the admin (service-role) client for the deals UPDATE because the
// per-user RLS on deals doesn't allow arbitrary writes to `notes` — only
// specific columns via the existing setField flow. call_logs itself has an
// "authenticated can all" policy so any signed-in CRM user can insert.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const dealId = Number(params.id);
  if (!Number.isFinite(dealId))
    return NextResponse.json({ error: "Bad deal id" }, { status: 400 });

  let body: { called_at?: string; notes?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const calledAtRaw = (body.called_at || "").trim();
  const notes = (body.notes || "").trim();
  if (!calledAtRaw)
    return NextResponse.json({ error: "called_at required" }, { status: 400 });
  if (!notes)
    return NextResponse.json({ error: "notes required" }, { status: 400 });

  // Parse called_at as a real Date so we can format it consistently for
  // the activity-log line. Accepts either ISO datetime ("2026-07-27T14:30")
  // or bare "YYYY-MM-DD HH:MM" — normalize to Date first.
  const calledAt = new Date(calledAtRaw.replace(" ", "T"));
  if (isNaN(calledAt.getTime()))
    return NextResponse.json(
      { error: `called_at is not a valid datetime: ${calledAtRaw}` },
      { status: 400 },
    );

  const admin = createAdminClient();

  // 1. Insert structured row.
  const { data: inserted, error: insErr } = await admin
    .from("call_logs")
    .insert({
      deal_id: dealId,
      called_at: calledAt.toISOString(),
      notes,
      created_by: user.email ?? null,
    })
    .select("id, called_at, notes")
    .single();
  if (insErr)
    return NextResponse.json({ error: insErr.message }, { status: 500 });

  // 2. Append to deals.notes (activity log) so the drawer shows it
  //    without a second query. Format:
  //      [2026-07-27 14:30 ET] Call log (alina@…): <notes>
  //    Times rendered in America/New_York to match the rest of the app.
  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(calledAt)
    .replace(",", "");
  const email = user.email ?? "unknown";
  const line = `[${stamp} ET] Call log (${email}): ${notes}`;

  const { data: existing, error: readErr } = await admin
    .from("deals")
    .select("notes")
    .eq("id", dealId)
    .maybeSingle();
  if (readErr)
    return NextResponse.json({ error: readErr.message }, { status: 500 });

  const nextNotes = existing?.notes ? `${existing.notes}\n${line}` : line;
  const { error: updErr } = await admin
    .from("deals")
    .update({ notes: nextNotes })
    .eq("id", dealId);
  if (updErr)
    return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, call_log: inserted, notes_line: line });
}
