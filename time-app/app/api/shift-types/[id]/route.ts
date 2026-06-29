import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "color", "sort_order", "active"]) if (k in body) patch[k] = body[k];
  for (const k of ["default_start", "default_end"]) if (k in body) patch[k] = body[k] || null;
  const supabase = createClient();
  const { data, error } = await supabase.from("shift_types").update(patch).eq("id", params.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ shiftType: data });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const supabase = createClient();
  // Soft-delete so existing shifts that reference the name are unaffected.
  const { error } = await supabase.from("shift_types").update({ active: false }).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
