import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function PATCH(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of [
    "employee_clockin_grace_min",
    "manager_clockin_grace_min",
    "tardy_grace_min",
    "shift_reminder_lead_min",
  ]) {
    if (k in body) {
      const n = Number(body[k]);
      if (!Number.isFinite(n) || n < 0 || n > 720)
        return NextResponse.json({ error: `Invalid ${k}` }, { status: 400 });
      patch[k] = Math.round(n);
    }
  }
  const supabase = createClient();
  const { data, error } = await supabase
    .from("app_settings")
    .update(patch)
    .eq("id", 1)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ settings: data });
}
