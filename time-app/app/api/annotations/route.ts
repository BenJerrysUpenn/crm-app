import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const b = await request.json();
  if (!b.title || !b.start_date)
    return NextResponse.json({ error: "Title and start date required" }, { status: 400 });
  const supabase = createClient();
  const { data, error } = await supabase
    .from("annotations")
    .insert({
      title: b.title,
      message: b.message ?? null,
      start_date: b.start_date,
      end_date: b.end_date && b.end_date >= b.start_date ? b.end_date : b.start_date,
      color: b.color ?? "#0ea5e9",
      business_closed: !!b.business_closed,
      no_time_off: !!b.no_time_off,
      announcement: !!b.announcement,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ annotation: data });
}
