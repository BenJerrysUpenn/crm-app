import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
import { NextResponse } from "next/server";

// Employee requests to drop one of their assigned shifts. Notifies managers.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const supabase = createClient();

  const { data: shift } = await supabase
    .from("shifts")
    .select("id, employee_id, starts_at, ends_at, position")
    .eq("id", params.id)
    .maybeSingle();
  if (!shift || shift.employee_id !== profile.id)
    return NextResponse.json({ error: "That isn't your shift." }, { status: 403 });

  // Avoid duplicate pending requests.
  const { data: existing } = await supabase
    .from("shift_requests")
    .select("id")
    .eq("shift_id", shift.id)
    .eq("employee_id", profile.id)
    .eq("status", "pending")
    .maybeSingle();
  if (existing) return NextResponse.json({ ok: true, alreadyRequested: true });

  const { error } = await supabase.from("shift_requests").insert({
    shift_id: shift.id,
    employee_id: profile.id,
    type: "drop",
    note: body.note ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Notify all managers.
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
      type: "drop_request",
      title: "Shift drop request",
      body: `${who} wants to drop ${fmtDate(shift.starts_at)} ${fmtTime(shift.starts_at)}–${fmtTime(shift.ends_at)}${shift.position ? " · " + shift.position : ""}.`,
      phone: m.phone ?? null,
      email,
    }).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
