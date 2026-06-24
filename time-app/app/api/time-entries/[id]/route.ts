import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  const patch: Record<string, unknown> = { manual: true };
  if ("clock_in_at" in body) patch.clock_in_at = body.clock_in_at;
  if ("clock_out_at" in body) {
    patch.clock_out_at = body.clock_out_at || null;
    patch.status = body.clock_out_at ? "closed" : "open";
  }
  if (patch.clock_in_at && patch.clock_out_at && new Date(patch.clock_out_at as string) <= new Date(patch.clock_in_at as string))
    return NextResponse.json({ error: "Clock-out must be after clock-in." }, { status: 400 });

  const supabase = createClient();
  const { data, error } = await supabase
    .from("time_entries")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ entry: data });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const supabase = createClient();
  const { error } = await supabase.from("time_entries").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
