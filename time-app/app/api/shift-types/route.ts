import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  if (!body.name) return NextResponse.json({ error: "Name required" }, { status: 400 });
  const supabase = createClient();
  const { data, error } = await supabase
    .from("shift_types")
    .insert({ name: body.name, color: body.color ?? "#10b981", sort_order: body.sort_order ?? 99 })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ shiftType: data });
}
