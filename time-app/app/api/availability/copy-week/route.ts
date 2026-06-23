import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

// Copy the employee's "available" blocks from the previous week into the target
// week. Body: { weekStart: "YYYY-MM-DD" } -> source is weekStart - 7 days.
function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { weekStart } = await request.json();
  const srcStart = addDays(weekStart, -7);
  const srcEnd = weekStart;
  const dstEnd = addDays(weekStart, 7);

  const supabase = createClient();

  const { data: src, error } = await supabase
    .from("availability")
    .select("specific_date, start_time, end_time")
    .eq("employee_id", profile.id)
    .eq("is_available", true)
    .gte("specific_date", srcStart)
    .lt("specific_date", srcEnd);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!src || src.length === 0) return NextResponse.json({ ok: true, copied: 0 });

  // Clear target week's available rows, then insert shifted copies.
  await supabase
    .from("availability")
    .delete()
    .eq("employee_id", profile.id)
    .eq("is_available", true)
    .not("specific_date", "is", null)
    .gte("specific_date", weekStart)
    .lt("specific_date", dstEnd);

  const rows = src.map((r) => ({
    employee_id: profile.id,
    specific_date: addDays(r.specific_date as string, 7),
    start_time: r.start_time,
    end_time: r.end_time,
    is_available: true,
    status: "approved",
  }));
  const { error: insErr } = await supabase.from("availability").insert(rows);
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
  return NextResponse.json({ ok: true, copied: rows.length });
}
