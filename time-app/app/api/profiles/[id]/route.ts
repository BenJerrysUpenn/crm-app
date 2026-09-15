import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  const patch: Record<string, unknown> = {};
  for (const k of ["full_name", "phone", "role", "hourly_rate", "active"]) {
    if (k in body) patch[k] = body[k];
  }
  const supabase = createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ profile: data });
}
