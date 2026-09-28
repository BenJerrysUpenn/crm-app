import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";
import { isManager } from "@/lib/roles";

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const profile = await getProfile();
  if (!profile || !isManager(profile))
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const supabase = createClient();
  const { error } = await supabase.from("annotations").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
