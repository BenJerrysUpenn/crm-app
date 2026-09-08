import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

// PATCH { active: boolean } — retire or re-activate a reminder. This is the
// only mutation managers get; title and body are immutable in the database.
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  let body: { active?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (typeof body.active !== "boolean")
    return NextResponse.json({ error: "active (true/false) required" }, { status: 400 });

  const supabase = createClient();
  const { data, error } = await supabase
    .from("clockin_reminders")
    .update({
      active: body.active,
      retired_at: body.active ? null : new Date().toISOString(),
    })
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ reminder: data });
}
