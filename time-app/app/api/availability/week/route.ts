import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { displayName, UNNAMED_IN_ALERTS } from "@/lib/profileName";
import { notifyManagers } from "@/lib/notify";
import { NextResponse } from "next/server";

function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

// Replace the employee's availability blocks for one week (date-based).
// Body: { weekStart, blocks: [{date, start_time, end_time, preference}] }.
export async function PUT(request: Request) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await request.json();
  const weekStart: string = body.weekStart;
  const weekEnd = addDays(weekStart, 7);
  const blocks: { date: string; start_time: string; end_time: string; preference?: string }[] =
    Array.isArray(body.blocks) ? body.blocks : [];

  const supabase = createClient();

  // Clear this employee's availability rows for the week.
  const { data: existing } = await supabase
    .from("availability")
    .select("id, specific_date")
    .eq("employee_id", profile.id)
    .eq("is_available", true)
    .not("specific_date", "is", null)
    .gte("specific_date", weekStart)
    .lt("specific_date", weekEnd);
  const toDelete = (existing ?? []).map((r) => r.id);
  if (toDelete.length) {
    const { error: delErr } = await supabase.from("availability").delete().in("id", toDelete);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 400 });
  }

  const rows = blocks.map((b) => ({
    employee_id: profile.id,
    specific_date: b.date,
    start_time: b.start_time,
    end_time: b.end_time,
    is_available: true,
    status: "approved",
    preference: ["available", "preferred", "unavailable"].includes(b.preference ?? "")
      ? b.preference
      : "available",
  }));
  if (rows.length) {
    const { error: insErr } = await supabase.from("availability").insert(rows);
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
  }

  await notifyManagers({
    type: "availability_change",
    title: "Availability updated",
    body: `${displayName(profile.full_name, UNNAMED_IN_ALERTS)} updated their availability.`,
  }).catch(() => {});

  return NextResponse.json({ ok: true, inserted: rows.length });
}
