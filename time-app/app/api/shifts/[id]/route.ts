import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
import { NextResponse } from "next/server";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await request.json();
  const supabase = createClient();

  // Detect a publish transition to fire a notification.
  const { data: before } = await supabase
    .from("shifts")
    .select("published")
    .eq("id", params.id)
    .single();

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of ["employee_id", "location_id", "starts_at", "ends_at", "position", "notes", "published"]) {
    if (k in body) patch[k] = body[k];
  }

  const { data, error } = await supabase
    .from("shifts")
    .update(patch)
    .eq("id", params.id)
    .select("*, profiles(id, full_name, phone)")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const becamePublished = !before?.published && data?.published;
  if (becamePublished && data.employee_id) {
    const emp = (data as any).profiles;
    const email = await emailForUser(data.employee_id);
    await notify({
      userId: data.employee_id,
      type: "shift_published",
      title: "New shift posted",
      body: `${fmtDate(data.starts_at)} · ${fmtTime(data.starts_at)}–${fmtTime(data.ends_at)}${data.position ? " · " + data.position : ""}`,
      phone: emp?.phone ?? null,
      email,
    }).catch(() => {});
  } else if (data?.published && data.employee_id) {
    // An already-published, assigned shift was edited -> tell the employee.
    const emp = (data as any).profiles;
    const email = await emailForUser(data.employee_id);
    await notify({
      userId: data.employee_id,
      type: "schedule_change",
      title: "Your shift was updated",
      body: `${fmtDate(data.starts_at)} · ${fmtTime(data.starts_at)}–${fmtTime(data.ends_at)}${data.position ? " · " + data.position : ""}`,
      phone: emp?.phone ?? null,
      email,
    }).catch(() => {});
  }
  return NextResponse.json({ shift: data });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const supabase = createClient();
  const { error } = await supabase.from("shifts").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
