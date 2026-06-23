import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const supabase = createClient();
  const { error } = await supabase.from("availability").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
