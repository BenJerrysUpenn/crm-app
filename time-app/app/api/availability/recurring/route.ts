import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

// Replace the signed-in employee's recurring weekly availability in one shot.
// Body: { blocks: [{ weekday: 0-6, start_time: "HH:MM:00", end_time: "HH:MM:00" }] }
export async function PUT(request: Request) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await request.json();
  const blocks: { weekday: number; start_time: string; end_time: string }[] =
    Array.isArray(body.blocks) ? body.blocks : [];

  const supabase = createClient();

  // Clear existing recurring "available" rows for this employee.
  const { error: delErr } = await supabase
    .from("availability")
    .delete()
    .eq("employee_id", profile.id)
    .not("weekday", "is", null)
    .eq("is_available", true);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 400 });

  if (blocks.length === 0) return NextResponse.json({ ok: true, inserted: 0 });

  const rows = blocks.map((b) => ({
    employee_id: profile.id,
    weekday: b.weekday,
    start_time: b.start_time,
    end_time: b.end_time,
    is_available: true,
  }));
  const { error: insErr } = await supabase.from("availability").insert(rows);
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });

  return NextResponse.json({ ok: true, inserted: rows.length });
}
