import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { displayName, UNNAMED_IN_ALERTS } from "@/lib/profileName";
import { createAdminClient } from "@/lib/supabase/admin";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
import { MANAGER_ASSIGNS_ERROR, managerAssignsOnly } from "@/lib/managerAssigns";
import { NextResponse } from "next/server";

// Employee claims an open (unassigned), published shift. Conditional update on
// employee_id IS NULL prevents two people grabbing the same shift.
//
// A catering shift (one with a deal_id) is refused for anyone but a manager:
// a manager assigns those (lib/managerAssigns.ts).
export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const supabase = createClient();
  if (profile.role !== "manager") {
    const { data: target } = await supabase
      .from("shifts")
      .select("deal_id")
      .eq("id", params.id)
      .maybeSingle();
    if (target && managerAssignsOnly(target))
      return NextResponse.json({ error: MANAGER_ASSIGNS_ERROR }, { status: 403 });
  }

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
    .eq("role", "manager");
  const who = displayName(profile.full_name, UNNAMED_IN_ALERTS);
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
