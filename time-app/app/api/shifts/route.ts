import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
import { isLongShift, shiftHours } from "@/lib/shiftChecks";
import { NextResponse } from "next/server";

// POST: create a shift (manager only). Body: employee_id, starts_at, ends_at,
// position, notes, location_id, published, confirmLong.
//
// A shift of 15+ hours is refused with 409 unless the body carries
// confirmLong: true. Nobody works a 26-hour shift on purpose, and one reached
// the published schedule from a catering deal because no layer ever asked.
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await request.json();

  const startsAt = typeof body.starts_at === "string" ? body.starts_at : "";
  const endsAt = typeof body.ends_at === "string" ? body.ends_at : "";
  const startMs = new Date(startsAt).getTime();
  const endMs = new Date(endsAt).getTime();
  if (!startsAt || !endsAt || Number.isNaN(startMs) || Number.isNaN(endMs))
    return NextResponse.json({ error: "A start and end time are required." }, { status: 400 });
  if (endMs <= startMs)
    return NextResponse.json({ error: "The end time must be after the start time." }, { status: 400 });
  if (isLongShift(startsAt, endsAt) && body.confirmLong !== true)
    return NextResponse.json({ error: "long_shift", hours: shiftHours(startsAt, endsAt) }, { status: 409 });

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

  if (body.published && data && body.employee_id) {
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
