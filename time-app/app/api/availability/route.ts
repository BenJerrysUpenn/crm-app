import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = await request.json();
  const supabase = createClient();
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
      // Time-off requests come in as pending; availability defaults approved.
      status: body.status ?? (body.is_available === false ? "pending" : "approved"),
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ availability: data });
}
