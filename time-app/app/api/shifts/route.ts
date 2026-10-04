import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { tellEmployeeAboutShift } from "@/lib/shiftNotice";
import { isLongShift, shiftHours } from "@/lib/shiftChecks";
import { availabilityDateRange, checkShiftAvailability } from "@/lib/availabilityCheck";
import { loadAvailabilityRows } from "@/lib/availabilityRows";
import { NextResponse } from "next/server";

// POST: create a shift (manager only). Body: employee_id, starts_at, ends_at,
// position, notes, location_id, confirmLong.
//
// There are no drafts: every shift is written live (published = true) and an
// assigned employee is told about it straight away. A `published` field in
// the body is ignored.
//
// A shift of 15+ hours is refused with 409 unless the body carries
// confirmLong: true. Nobody works a 26-hour shift on purpose, and one reached
// the published schedule from a catering deal because no layer ever asked.
//
// A shift assigned to someone whose availability does not cover it (time off,
// a "can't work" block, hours outside what they gave, or nothing on file) is
// refused with 409 "availability_mismatch" unless the body carries
// confirmAvailability: true. If availability cannot be read it is 503
// "availability_unavailable" — never a silent pass. See lib/availabilityCheck.ts.
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

  if (body.employee_id && body.confirmAvailability !== true) {
    const candidate = { employee_id: String(body.employee_id), position: body.position ?? null, starts_at: startsAt, ends_at: endsAt };
    const range = availabilityDateRange([candidate]);
    if (range) {
      const load = await loadAvailabilityRows(supabase, range, [candidate.employee_id]);
      if (!load.ok) return NextResponse.json({ error: "availability_unavailable" }, { status: 503 });
      const mismatch = checkShiftAvailability(candidate, load.rows);
      if (mismatch) return NextResponse.json({ error: "availability_mismatch", mismatch }, { status: 409 });
    }
  }

  const { data, error } = await supabase
    .from("shifts")
    .insert({
      employee_id: body.employee_id,
      location_id: body.location_id ?? null,
      starts_at: body.starts_at,
      ends_at: body.ends_at,
      position: body.position ?? null,
      notes: body.notes ?? null,
      published: true,
    })
    .select("*, profiles(id, full_name, phone)")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  if (data && body.employee_id) {
    const emp = (data as any).profiles;
    await tellEmployeeAboutShift("posted", { ...data, employee_id: body.employee_id }, emp?.phone ?? null);
  }
  return NextResponse.json({ shift: data });
}
