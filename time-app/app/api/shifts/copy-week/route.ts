import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { tellEmployeeAboutShift } from "@/lib/shiftNotice";
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

// Copy all shifts from the previous week into the given week. There are no
// drafts: the copies are live as soon as they are written, and each assigned
// employee gets the same "New shift posted" message creating the shift by hand
// sends (and that publishing the week used to send).
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
    published: true,
  }));
  const { data: inserted, error: insErr } = await supabase
    .from("shifts")
    .insert(rows)
    .select("employee_id, starts_at, ends_at, position");
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });

  const copies = (inserted ?? []) as { employee_id: string | null; starts_at: string; ends_at: string; position: string | null }[];
  const ids = Array.from(new Set(copies.map((s) => s.employee_id).filter((id): id is string => !!id)));
  const phoneById = new Map<string, string | null>();
  if (ids.length) {
    const { data: people } = await supabase.from("profiles").select("id, phone").in("id", ids);
    for (const p of (people ?? []) as { id: string; phone: string | null }[]) phoneById.set(p.id, p.phone);
  }
  for (const s of copies) {
    if (!s.employee_id) continue;
    await tellEmployeeAboutShift("posted", { ...s, employee_id: s.employee_id }, phoneById.get(s.employee_id) ?? null);
  }

  return NextResponse.json({ ok: true, copied: rows.length });
}
