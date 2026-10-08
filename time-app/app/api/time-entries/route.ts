import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

// Manager creates a manual time entry. Body: { employee_id, clock_in_at, clock_out_at?, shift_id? }
//
// The Timesheets page and the payroll page's inline fixes both add punches
// here. shift_id is optional: the payroll page names the shift a missing
// catering punch was worked against, so the verifier counts that person as
// the event's crew (bj-finance #519, ruled 2026-10-05).
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
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
