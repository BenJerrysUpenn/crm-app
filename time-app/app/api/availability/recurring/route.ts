import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { dayKey } from "@/lib/format";
import { changedKeys, queueAvailabilityChange } from "@/lib/availabilityNotice";
import { missingRepeatUntilColumn, parseRepeatUntil, REPEAT_UNTIL_NOT_READY } from "@/lib/repeatUntil";
import { NextResponse } from "next/server";

// Replace the signed-in employee's recurring weekly availability in one shot.
// Body: { repeat_until: "YYYY-MM-DD",
//         blocks: [{ weekday: 0-6, start_time: "HH:MM:00", end_time: "HH:MM:00" }] }
//
// Weekly blocks repeat until a date (migration 48, lib/repeatUntil.ts):
// repeat_until is required whenever there are blocks, and every block saved
// carries it. The weekdays whose blocks changed are queued for the schedulers:
// on their bell now, in the 8pm email (lib/availabilityNotice.ts).
export async function PUT(request: Request) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await request.json();
  const blocks: { weekday: number; start_time: string; end_time: string }[] =
    Array.isArray(body.blocks) ? body.blocks : [];

  let repeatUntil: string | null = null;
  if (blocks.length) {
    const parsed = parseRepeatUntil(body.repeat_until, dayKey(new Date().toISOString()));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    repeatUntil = parsed.value;
  }

  const supabase = createClient();

  // The weekly rows as they stand, to tell which weekdays the save changes.
  const { data: before } = await supabase
    .from("availability")
    .select("*")
    .eq("employee_id", profile.id)
    .not("weekday", "is", null)
    .eq("is_available", true);

  const rows = blocks.map((b) => ({
    employee_id: profile.id,
    weekday: b.weekday,
    start_time: b.start_time,
    end_time: b.end_time,
    is_available: true,
    repeat_until: repeatUntil,
  }));

  // Before migration 48 a row cannot carry repeat_until: refuse before
  // deleting anything, rather than lose the old pattern.
  if (rows.length && before?.length && !("repeat_until" in before[0])) {
    return NextResponse.json({ error: REPEAT_UNTIL_NOT_READY }, { status: 503 });
  }

  // Clear existing recurring "available" rows for this employee.
  const { error: delErr } = await supabase
    .from("availability")
    .delete()
    .eq("employee_id", profile.id)
    .not("weekday", "is", null)
    .eq("is_available", true);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 400 });

  if (rows.length) {
    const { error: insErr } = await supabase.from("availability").insert(rows);
    if (insErr) {
      if (missingRepeatUntilColumn(insErr)) return NextResponse.json({ error: REPEAT_UNTIL_NOT_READY }, { status: 503 });
      return NextResponse.json({ error: insErr.message }, { status: 400 });
    }
  }

  await queueAvailabilityChange(profile, {
    dates: [],
    weekdays: changedKeys(before ?? [], rows, (r) => r.weekday),
  });

  return NextResponse.json({ ok: true, inserted: rows.length });
}
