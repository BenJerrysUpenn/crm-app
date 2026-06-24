import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

// Employee confirms (acknowledges) one of their assigned shifts.
export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const supabase = createClient();
  const { data: shift } = await supabase
    .from("shifts")
    .select("id, employee_id")
    .eq("id", params.id)
    .maybeSingle();
  if (!shift || shift.employee_id !== profile.id)
    return NextResponse.json({ error: "That isn't your shift." }, { status: 403 });

  // Use the admin client so we only ever touch acknowledged_at (no RLS hole
  // that would let employees edit shift times).
  const admin = createAdminClient();
  const { error } = await admin
    .from("shifts")
    .update({ acknowledged_at: new Date().toISOString() })
    .eq("id", shift.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
