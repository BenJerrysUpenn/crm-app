import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

// Manager creates a manual time entry. Body: { employee_id, clock_in_at, clock_out_at? }
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  if (!body.employee_id || !body.clock_in_at)
    return NextResponse.json({ error: "Employee and clock-in time required." }, { status: 400 });
  if (body.clock_out_at && new Date(body.clock_out_at) <= new Date(body.clock_in_at))
    return NextResponse.json({ error: "Clock-out must be after clock-in." }, { status: 400 });

  const supabase = createClient();
  const { data, error } = await supabase
    .from("time_entries")
    .insert({
      employee_id: body.employee_id,
      clock_in_at: body.clock_in_at,
      clock_out_at: body.clock_out_at ?? null,
      status: body.clock_out_at ? "closed" : "open",
      manual: true,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ entry: data });
}
