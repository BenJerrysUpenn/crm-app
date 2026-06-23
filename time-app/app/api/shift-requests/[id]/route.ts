import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
import { NextResponse } from "next/server";

// Manager approves/denies a drop request. Approving releases the shift (open).
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const { status } = await request.json();
  if (!["approved", "denied"].includes(status))
    return NextResponse.json({ error: "Bad status" }, { status: 400 });

  const supabase = createClient();
  const { data: req } = await supabase
    .from("shift_requests")
    .select("id, shift_id, employee_id, status")
    .eq("id", params.id)
    .maybeSingle();
  if (!req) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await supabase.from("shift_requests").update({ status }).eq("id", req.id);

  let shiftInfo: { starts_at: string; ends_at: string; position: string | null } | null = null;
  if (status === "approved") {
    // Release the shift back to open.
    const { data: s } = await supabase
      .from("shifts")
      .update({ employee_id: null, updated_at: new Date().toISOString() })
      .eq("id", req.shift_id)
      .select("starts_at, ends_at, position")
      .maybeSingle();
    shiftInfo = s ?? null;
  } else {
    const { data: s } = await supabase
      .from("shifts")
      .select("starts_at, ends_at, position")
      .eq("id", req.shift_id)
      .maybeSingle();
    shiftInfo = s ?? null;
  }

  // Tell the employee the outcome.
  const email = await emailForUser(req.employee_id);
  const { data: emp } = await supabase
    .from("profiles")
    .select("phone")
    .eq("id", req.employee_id)
    .maybeSingle();
  const when = shiftInfo
    ? `${fmtDate(shiftInfo.starts_at)} ${fmtTime(shiftInfo.starts_at)}–${fmtTime(shiftInfo.ends_at)}`
    : "your shift";
  await notify({
    userId: req.employee_id,
    type: "drop_decision",
    title: status === "approved" ? "Shift drop approved" : "Shift drop denied",
    body:
      status === "approved"
        ? `You've been released from ${when}.`
        : `Your request to drop ${when} was denied. You're still scheduled.`,
    phone: emp?.phone ?? null,
    email,
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
