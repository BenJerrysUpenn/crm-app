import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
import { NextResponse } from "next/server";

// POST: create a shift (manager only). Body: employee_id, starts_at, ends_at,
// position, notes, location_id, published.
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await request.json();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("shifts")
    .insert({
      employee_id: body.employee_id,
      location_id: body.location_id ?? null,
      starts_at: body.starts_at,
      ends_at: body.ends_at,
      position: body.position ?? null,
      notes: body.notes ?? null,
      published: !!body.published,
    })
    .select("*, profiles(id, full_name, phone)")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  if (body.published && data) {
    const emp = (data as any).profiles;
    const email = await emailForUser(body.employee_id);
    await notify({
      userId: body.employee_id,
      type: "shift_published",
      title: "New shift posted",
      body: `${fmtDate(data.starts_at)} · ${fmtTime(data.starts_at)}–${fmtTime(data.ends_at)}${data.position ? " · " + data.position : ""}`,
      phone: emp?.phone ?? null,
      email,
    }).catch(() => {});
  }
  return NextResponse.json({ shift: data });
}
