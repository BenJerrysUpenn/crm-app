import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";
import { isManager } from "@/lib/roles";

// Manager creates a manual time entry. Body: { employee_id, clock_in_at, clock_out_at?, shift_id? }
//
// The Timesheets page and the payroll page's inline fixes both add punches
// here. shift_id is optional: the payroll page names the shift a missing
// catering punch was worked against, so the verifier counts that person as
// the event's crew (bj-finance #519, ruled 2026-10-05).
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || !isManager(profile))
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  if (body.restores !== undefined) return restore(body.restores);
  if (!body.employee_id || !body.clock_in_at)
    return NextResponse.json({ error: "Employee and clock-in time required." }, { status: 400 });
  if (body.clock_out_at && new Date(body.clock_out_at) <= new Date(body.clock_in_at))
    return NextResponse.json({ error: "Clock-out must be after clock-in." }, { status: 400 });
  const shiftId = body.shift_id ?? null;
  if (shiftId !== null && !(Number.isInteger(shiftId) && shiftId > 0))
    return NextResponse.json({ error: "shift_id must be a shift's id." }, { status: 400 });

  const supabase = createClient();
  const { data, error } = await supabase
    .from("time_entries")
    .insert({
      employee_id: body.employee_id,
      clock_in_at: body.clock_in_at,
      clock_out_at: body.clock_out_at ?? null,
      status: body.clock_out_at ? "closed" : "open",
      manual: true,
      shift_id: shiftId,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ entry: data });
}

// Undo of a delete on Timesheets: { restores: <the deleted punch's id> }. The
// punch comes back from the copy the database kept when it was deleted
// (row_audit, migration 25), every column as it was: a real clock-in stays a
// real clock-in with its location, not a hand-made one. Nothing from the
// browser is written. It gets a new id.
async function restore(formerId: unknown): Promise<NextResponse> {
  if (!(Number.isInteger(formerId) && (formerId as number) > 0))
    return NextResponse.json({ error: "restores must be a time entry's id." }, { status: 400 });
  const admin = createAdminClient();
  const { data: audit, error: readError } = await admin
    .from("row_audit")
    .select("before_image")
    .eq("table_name", "time_entries")
    .eq("op", "DELETE")
    .eq("row_id", formerId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 503 });
  const image = (audit as { before_image?: Record<string, unknown> | null } | null)?.before_image;
  if (!image) return NextResponse.json({ error: "There is no record of that punch to put back." }, { status: 404 });
  const { id: _formerId, ...row } = image;
  const { data, error } = await createClient().from("time_entries").insert(row).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ entry: data });
}
