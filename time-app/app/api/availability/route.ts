import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { notifyManagers } from "@/lib/notify";
import { fmtDate } from "@/lib/format";
import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { addDays } from "@/lib/coverage";
import { todayInNewYork } from "@/lib/timeOff";

export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = await request.json();
  const supabase = createClient();

  // Time-off range: start_date .. end_date (inclusive) -> one row per day,
  // tied by a shared request_group so it can be approved/deleted as a unit.
  if (body.start_date) {
    const start: string = body.start_date;
    const end: string = body.end_date && body.end_date >= start ? body.end_date : start;

    // Block days inside a manager's "don't allow time off" annotation range.
    const noTimeOffDays = new Set<string>();
    const { data: anns } = await supabase
      .from("annotations")
      .select("start_date, end_date, no_time_off")
      .eq("no_time_off", true)
      .lte("start_date", end)
      .gte("end_date", start);
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if ((anns ?? []).some((a) => d >= (a.start_date as string) && d <= (a.end_date as string))) {
        noTimeOffDays.add(d);
      }
    }

    const today = todayInNewYork(new Date());
    const group = randomUUID();
    const rows: Record<string, unknown>[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (d < today) continue; // can't request off for past days
      if (noTimeOffDays.has(d)) continue; // manager blocked time off on this day
      rows.push({
        employee_id: profile.id,
        specific_date: d,
        is_available: body.is_available ?? false,
        note: body.note ?? null,
        status: body.status ?? "pending",
        request_group: group,
      });
      if (rows.length > 366) break; // safety
    }
    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Those day(s) are in the past or a manager has blocked time off on them, so you can't request them off. Ask a manager." },
        { status: 409 },
      );
    }
    const { error } = await supabase.from("availability").insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    // Notify managers of a new time-off request.
    if ((body.is_available ?? false) === false) {
      const who = profile.full_name ?? "An employee";
      const when =
        start === end
          ? fmtDate(start + "T12:00:00")
          : `${fmtDate(start + "T12:00:00")}–${fmtDate(end + "T12:00:00")}`;
      await notifyManagers({
        type: "time_off_request",
        title: "New time-off request",
        body: `${who} requested time off for ${when}.${body.note ? " Note: " + body.note : ""}`,
      }).catch(() => {});
    }
    return NextResponse.json({ ok: true, days: rows.length, group });
  }

  // Single preference insert (a calendar "Add Preference": unavailable/prefer,
  // optional time range, optional weekly repeat).
  // Block adding a preference for a past day.
  if (body.specific_date) {
    if (body.specific_date < todayInNewYork(new Date())) {
      return NextResponse.json(
        { error: "You can't change availability for a day that's passed." },
        { status: 409 },
      );
    }
  }
  const { data, error } = await supabase
    .from("availability")
    .insert({
      employee_id: profile.id,
      weekday: body.weekday ?? null,
      specific_date: body.specific_date ?? null,
      start_time: body.start_time ?? null,
      end_time: body.end_time ?? null,
      is_available: body.is_available ?? true,
      note: body.note ?? null,
      preference: ["available", "preferred", "unavailable"].includes(body.preference)
        ? body.preference
        : "available",
      status: body.status ?? (body.is_available === false ? "pending" : "approved"),
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (body.is_available !== false) {
    await notifyManagers({
      type: "availability_change",
      title: "Availability updated",
      body: `${profile.full_name ?? "An employee"} updated their availability.`,
    }).catch(() => {});
  }
  return NextResponse.json({ availability: data });
}
