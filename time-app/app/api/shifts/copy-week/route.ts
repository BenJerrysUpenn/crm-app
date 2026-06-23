import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

const TZ = "America/New_York";
function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function nyDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

// Copy all shifts from the previous week into the given week (as drafts).
// Body: { weekStart: "YYYY-MM-DD" }  -> source is weekStart - 7 days.
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const { weekStart } = await request.json();
  if (!weekStart) return NextResponse.json({ error: "weekStart required" }, { status: 400 });

  const srcStart = addDays(weekStart, -7);
  // Pad the query window a day each side, then filter precisely by Eastern date.
  const qStart = addDays(srcStart, -1) + "T00:00:00Z";
  const qEnd = addDays(srcStart, 8) + "T00:00:00Z";

  const supabase = createClient();
  const { data: prev, error } = await supabase
    .from("shifts")
    .select("employee_id, location_id, starts_at, ends_at, position, notes")
    .gte("starts_at", qStart)
    .lt("starts_at", qEnd);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Keep only shifts whose Eastern date falls in the source week.
  const inWeek = (prev ?? []).filter((s) => {
    const d = nyDate(s.starts_at as string);
    return d >= srcStart && d < weekStart;
  });
  if (inWeek.length === 0) return NextResponse.json({ ok: true, copied: 0 });

  const rows = inWeek.map((s) => ({
    employee_id: s.employee_id,
    location_id: s.location_id,
    starts_at: new Date(new Date(s.starts_at as string).getTime() + 7 * 86400000).toISOString(),
    ends_at: new Date(new Date(s.ends_at as string).getTime() + 7 * 86400000).toISOString(),
    position: s.position,
    notes: s.notes,
    published: false,
  }));
  const { error: insErr } = await supabase.from("shifts").insert(rows);
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
  return NextResponse.json({ ok: true, copied: rows.length });
}
