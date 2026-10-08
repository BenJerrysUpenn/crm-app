import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { isMissingInStoreColumn } from "@/lib/storeHours";
import { NextResponse } from "next/server";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "color", "sort_order", "active"]) if (k in body) patch[k] = body[k];
  for (const k of ["default_start", "default_end"]) if (k in body) patch[k] = body[k] || null;
  // Only in-store shift types count toward store coverage; Catering,
  // Marketing and Staff Meeting do not.
  if ("in_store" in body) patch.in_store = !!body.in_store;
  const supabase = createClient();
  let { data, error } = await supabase
    .from("shift_types")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();
  // Before migration 24 there is no in_store column. Editing a name or colour
  // must not fail because of it, so drop it and retry once.
  if (error && isMissingInStoreColumn(error) && "in_store" in patch) {
    delete patch.in_store;
    if (Object.keys(patch).length === 0)
      return NextResponse.json(
        { error: "In-store needs migration 24. Run it in Supabase first." },
        { status: 503 },
      );
    ({ data, error } = await supabase
      .from("shift_types")
      .update(patch)
      .eq("id", params.id)
      .select()
      .single());
    if (!error)
      return NextResponse.json({
        shiftType: data,
        warning: "Saved, but In-store was not recorded: run migration 24 in Supabase.",
      });
  }
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
