import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { notifyManagers } from "@/lib/notify";
import { fmtDate } from "@/lib/format";
import { randomUUID } from "crypto";
import { NextResponse } from "next/server";

function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

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

    // A day is locked only if THAT exact day already has a published shift.
    const { data: pub } = await supabase
      .from("shifts")
      .select("starts_at")
      .eq("published", true)
      .gte("starts_at", start + "T00:00:00Z")
      .lt("starts_at", addDays(end, 1) + "T00:00:00Z");
    const lockedDays = new Set(
      (pub ?? [])
        .map((s) => new Date(s.starts_at as string).toLocaleDateString("en-CA", { timeZone: "America/New_York" }))
        .filter((d) => d >= start && d <= end),
    );

    // Also block days inside a "don't allow time off" annotation range.
    const { data: anns } = await supabase
      .from("annotations")
      .select("start_date, end_date, no_time_off")
      .eq("no_time_off", true)
      .lte("start_date", end)
      .gte("end_date", start);
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if ((anns ?? []).some((a) => d >= (a.start_date as string) && d <= (a.end_date as string))) {
        lockedDays.add(d);
      }
    }

    const group = randomUUID();
    const rows: Record<string, unknown>[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (lockedDays.has(d)) continue; // skip only the posted days
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
        { error: "The schedule is already posted for those day(s), so you can't request them off. Ask a manager." },
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
  // Block adding a preference for a day that's already posted.
  if (body.specific_date) {
    const { data: pubChk } = await supabase
      .from("shifts")
      .select("starts_at")
      .eq("published", true)
      .gte("starts_at", body.specific_date + "T00:00:00Z")
      .lt("starts_at", addDays(body.specific_date, 1) + "T00:00:00Z");
    const locked = (pubChk ?? []).some(
      (s) => new Date(s.starts_at as string).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === body.specific_date,
    );
    if (locked) {
      return NextResponse.json(
        { error: "That day's schedule is already posted, so you can't change availability for it." },
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
