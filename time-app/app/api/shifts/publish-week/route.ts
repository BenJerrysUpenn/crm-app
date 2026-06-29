import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
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

// Publish every draft shift in the given week. Body: { weekStart: "YYYY-MM-DD" }
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const { weekStart } = await request.json();
  if (!weekStart) return NextResponse.json({ error: "weekStart required" }, { status: 400 });
  const weekEnd = addDays(weekStart, 7);
  const qStart = addDays(weekStart, -1) + "T00:00:00Z";
  const qEnd = addDays(weekStart, 8) + "T00:00:00Z";

  const supabase = createClient();
  const { data: drafts, error } = await supabase
    .from("shifts")
    .select("id, employee_id, starts_at, ends_at, position")
    .eq("published", false)
    .gte("starts_at", qStart)
    .lt("starts_at", qEnd);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const inWeek = (drafts ?? []).filter((s) => {
    const d = nyDate(s.starts_at as string);
    return d >= weekStart && d < weekEnd;
  });
  if (inWeek.length === 0) return NextResponse.json({ ok: true, published: 0 });

  const { error: upErr } = await supabase
    .from("shifts")
    .update({ published: true, updated_at: new Date().toISOString() })
    .in("id", inWeek.map((s) => s.id));
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 400 });

  // Notify each assigned employee about their newly posted shift(s).
  for (const s of inWeek) {
    if (!s.employee_id) continue;
    const email = await emailForUser(s.employee_id as string);
    const { data: emp } = await supabase.from("profiles").select("phone").eq("id", s.employee_id).maybeSingle();
    await notify({
      userId: s.employee_id as string,
      type: "shift_published",
      title: "New shift posted",
      body: `${fmtDate(s.starts_at as string)} · ${fmtTime(s.starts_at as string)}–${fmtTime(s.ends_at as string)}${s.position ? " · " + s.position : ""}`,
      phone: emp?.phone ?? null,
      email,
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, published: inWeek.length });
}
