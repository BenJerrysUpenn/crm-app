import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
import { NextResponse } from "next/server";

// Employee claims an open (unassigned), published shift. Conditional update on
// employee_id IS NULL prevents two people grabbing the same shift.
export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const supabase = createClient();
  const { data, error } = await supabase
    .from("shifts")
    .update({ employee_id: profile.id, updated_at: new Date().toISOString() })
    .eq("id", params.id)
    .is("employee_id", null)
    .eq("published", true)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data)
    return NextResponse.json(
      { error: "That shift was just taken or is no longer open." },
      { status: 409 },
    );

  // Tell managers an open shift was picked up.
  const admin = createAdminClient();
  const { data: managers } = await admin
    .from("profiles")
    .select("id, phone")
    .eq("role", "manager")
    .eq("active", true);
  const who = profile.full_name ?? "An employee";
  for (const m of managers ?? []) {
    const email = await emailForUser(m.id);
    await notify({
      userId: m.id,
      type: "shift_picked_up",
      title: "Open shift picked up",
      body: `${who} picked up ${fmtDate(data.starts_at)} ${fmtTime(data.starts_at)}–${fmtTime(data.ends_at)}${data.position ? " · " + data.position : ""}.`,
      phone: m.phone ?? null,
      email,
    }).catch(() => {});
  }

  return NextResponse.json({ shift: data });
}
