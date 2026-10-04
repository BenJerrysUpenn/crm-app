import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { tellEmployeeAboutShift } from "@/lib/shiftNotice";
import { isLongShift, shiftHours } from "@/lib/shiftChecks";
import { availabilityDateRange, checkShiftAvailability } from "@/lib/availabilityCheck";
import { loadAvailabilityRows } from "@/lib/availabilityRows";
import { NextResponse } from "next/server";

// PATCH: edit a shift (manager only). Body carries any of employee_id,
// location_id, starts_at, ends_at, position, notes, plus confirmLong.
//
// There are no drafts: an edit always leaves the shift live (published =
// true), whatever the body says, and the assigned employee is told.
//
// An edit that leaves the shift 15+ hours long is refused with 409 unless the
// body carries confirmLong: true. The check is run against the shift as it will
// be, not as the body describes it — moving only the end time still has to be
// judged against the stored start.
//
// An edit that changes who is on the shift or when it runs, and leaves it with
// someone whose availability does not cover it, is refused with 409
// "availability_mismatch" unless the body carries confirmAvailability: true
// (503 "availability_unavailable" if availability cannot be read). An edit
// that touches neither — notes, location — is not re-asked, so a
// shift the manager already confirmed does not nag on every save.
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await request.json();
  const supabase = createClient();

  // The shift as it stands: the times the patch is applied on top of, and
  // whether it is still unpublished.
  const { data: before } = await supabase
    .from("shifts")
    .select("published, starts_at, ends_at, employee_id, position")
    .eq("id", params.id)
    .single();

  const startsAt = (("starts_at" in body ? body.starts_at : before?.starts_at) ?? "") as string;
  const endsAt = (("ends_at" in body ? body.ends_at : before?.ends_at) ?? "") as string;
  if (startsAt && endsAt) {
    const startMs = new Date(startsAt).getTime();
    const endMs = new Date(endsAt).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs))
      return NextResponse.json({ error: "A start and end time are required." }, { status: 400 });
    if (endMs <= startMs)
      return NextResponse.json({ error: "The end time must be after the start time." }, { status: 400 });
    if (isLongShift(startsAt, endsAt) && body.confirmLong !== true)
      return NextResponse.json({ error: "long_shift", hours: shiftHours(startsAt, endsAt) }, { status: 409 });
  }

  const employeeAfter = ("employee_id" in body ? body.employee_id : before?.employee_id) ?? null;
  const sameInstant = (a: unknown, b: unknown) =>
    typeof a === "string" && typeof b === "string" && new Date(a).getTime() === new Date(b).getTime();
  const whoOrWhenChanged =
    !before ||
    employeeAfter !== (before.employee_id ?? null) ||
    !sameInstant(startsAt, before.starts_at) ||
    !sameInstant(endsAt, before.ends_at);
  if (employeeAfter && startsAt && endsAt && whoOrWhenChanged && body.confirmAvailability !== true) {
    const candidate = {
      id: Number(params.id),
      employee_id: String(employeeAfter),
      position: ("position" in body ? body.position : before?.position) ?? null,
      starts_at: startsAt,
      ends_at: endsAt,
    };
    const range = availabilityDateRange([candidate]);
    if (range) {
      const load = await loadAvailabilityRows(supabase, range, [candidate.employee_id]);
      if (!load.ok) return NextResponse.json({ error: "availability_unavailable" }, { status: 503 });
      const mismatch = checkShiftAvailability(candidate, load.rows);
      if (mismatch) return NextResponse.json({ error: "availability_mismatch", mismatch }, { status: 409 });
    }
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), published: true };
  for (const k of ["employee_id", "location_id", "starts_at", "ends_at", "position", "notes"]) {
    if (k in body) patch[k] = body[k];
  }

  const { data, error } = await supabase
    .from("shifts")
    .update(patch)
    .eq("id", params.id)
    .select("*, profiles(id, full_name, phone)")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // A shift that is new to this person (an unpublished row going live, or one
  // just assigned to them) reads as a new shift. Any other edit of an assigned
  // shift is a change.
  const newToThem = before?.published === false || (before?.employee_id ?? null) !== (data?.employee_id ?? null);
  if (newToThem && data?.employee_id) {
    const emp = (data as any).profiles;
    await tellEmployeeAboutShift("posted", data, emp?.phone ?? null);
  } else if (data?.employee_id) {
    // An assigned shift was edited -> tell the employee.
    const emp = (data as any).profiles;
    await tellEmployeeAboutShift("changed", data, emp?.phone ?? null);
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
