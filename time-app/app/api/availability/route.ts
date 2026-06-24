import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
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
    const group = randomUUID();
    const rows: Record<string, unknown>[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
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
    const { error } = await supabase.from("availability").insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, days: rows.length, group });
  }

  // Legacy single-day insert.
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
      status: body.status ?? (body.is_available === false ? "pending" : "approved"),
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ availability: data });
}
