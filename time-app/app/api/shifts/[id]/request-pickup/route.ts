import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
import { NextResponse } from "next/server";

// Employee requests to pick up an open (unassigned), published shift.
// Creates a pending shift_requests row of type='pickup' and notifies managers.
// The shift itself is NOT assigned here — a manager approves via the standard
// PATCH /api/shift-requests/:id endpoint. Mirrors the existing drop request
// pattern (see .../shifts/[id]/drop/route.ts).
//
// Per Alina 2026-08-27: employees can't self-pick-up any more. This is the
// replacement for the direct /api/shifts/:id/claim endpoint on the employee
// side. That claim endpoint stays available for managers.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;

  const supabase = createClient();
  const { data: shift } = await supabase
    .from("shifts")
    .select("id, employee_id, published, starts_at, ends_at, position")
    .eq("id", params.id)
    .maybeSingle();
  if (!shift)
    return NextResponse.json({ error: "Shift not found" }, { status: 404 });
  if (!shift.published)
    return NextResponse.json({ error: "Shift isn't published yet." }, { status: 409 });
  if (shift.employee_id)
    return NextResponse.json({ error: "That shift is already assigned." }, { status: 409 });

  // De-dupe: don't stack pending pickup requests from the same employee for
  // the same shift.
  const { data: existing } = await supabase
    .from("shift_requests")
    .select("id")
    .eq("shift_id", shift.id)
    .eq("employee_id", profile.id)
    .eq("type", "pickup")
    .eq("status", "pending")
    .maybeSingle();
  if (existing) return NextResponse.json({ ok: true, alreadyRequested: true });

  const { error } = await supabase.from("shift_requests").insert({
    shift_id: shift.id,
    employee_id: profile.id,
    type: "pickup",
    status: "pending",
    note,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Notify managers.
  const admin = createAdminClient();
  const { data: managers } = await admin
    .from("profiles")
    .select("id, phone")
    .eq("role", "manager");
  const who = profile.full_name ?? "An employee";
  const when = `${fmtDate(shift.starts_at)} ${fmtTime(shift.starts_at)}–${fmtTime(shift.ends_at)}`;
  const posBit = shift.position ? " · " + shift.position : "";
  for (const m of managers ?? []) {
    const email = await emailForUser(m.id);
    await notify({
      userId: m.id,
      type: "shift_pickup_requested",
      title: "Shift pickup requested",
      body: `${who} wants ${when}${posBit}. Approve or deny in Schedule.`,
      phone: m.phone ?? null,
      email,
    }).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
