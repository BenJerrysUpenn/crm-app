import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("locations")
    .insert({
      name: body.name,
      latitude: body.latitude,
      longitude: body.longitude,
      radius_meters: body.radius_meters ?? 150,
      is_default: !!body.is_default,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ location: data });
}
