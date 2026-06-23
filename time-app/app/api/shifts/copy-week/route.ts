import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

// Copy all shifts from the previous week into the given week (as drafts).
// Body: { weekStartISO }  -> source is weekStart - 7 days.
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const { weekStartISO } = await request.json();
  const target = new Date(weekStartISO);
  const source = new Date(target);
  source.setDate(source.getDate() - 7);
  const sourceEnd = new Date(source);
  sourceEnd.setDate(sourceEnd.getDate() + 7);

  const supabase = createClient();
  const { data: prev, error } = await supabase
    .from("shifts")
    .select("employee_id, location_id, starts_at, ends_at, position, notes")
    .gte("starts_at", source.toISOString())
    .lt("starts_at", sourceEnd.toISOString());
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!prev || prev.length === 0)
    return NextResponse.json({ ok: true, copied: 0 });

  const rows = prev.map((s) => ({
    employee_id: s.employee_id,
    location_id: s.location_id,
    starts_at: new Date(new Date(s.starts_at).getTime() + 7 * 86400000).toISOString(),
    ends_at: new Date(new Date(s.ends_at).getTime() + 7 * 86400000).toISOString(),
    position: s.position,
    notes: s.notes,
    published: false,
  }));
  const { error: insErr } = await supabase.from("shifts").insert(rows);
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
  return NextResponse.json({ ok: true, copied: rows.length });
}
