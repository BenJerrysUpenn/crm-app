import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";
import { NextResponse } from "next/server";

// Manager approves/denies a shift_request. Handles both types:
//   type='drop'   → on approve, release the shift (employee_id = NULL)
//   type='pickup' → on approve, assign shift.employee_id = req.employee_id
//                   (only if the shift is still open; otherwise return 409)
// On deny, nothing changes to the shift; we just mark the request denied
// and notify the employee.
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
    .select("id, shift_id, employee_id, status, type")
    .eq("id", params.id)
    .maybeSingle();
  if (!req) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const kind: "drop" | "pickup" = (req.type as "drop" | "pickup") ?? "drop";

  let shiftInfo: { starts_at: string; ends_at: string; position: string | null } | null = null;

  if (status === "approved") {
    if (kind === "drop") {
      // Release the shift back to open.
      const { data: s } = await supabase
        .from("shifts")
        .update({ employee_id: null, updated_at: new Date().toISOString() })
        .eq("id", req.shift_id)
        .select("starts_at, ends_at, position")
        .maybeSingle();
      shiftInfo = s ?? null;
    } else {
      // Pickup: assign the requesting employee IF the shift is still open.
      // Conditional update on employee_id IS NULL prevents overwriting an
      // assignment that happened between request and approval.
      const { data: s } = await supabase
        .from("shifts")
        .update({
          employee_id: req.employee_id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", req.shift_id)
        .is("employee_id", null)
        .select("starts_at, ends_at, position")
        .maybeSingle();
      if (!s) {
        // Someone else got the shift already; mark this request denied
        // rather than approved, and tell the caller.
        await supabase
          .from("shift_requests")
          .update({ status: "denied" })
          .eq("id", req.id);
        return NextResponse.json(
          { error: "Shift is no longer open — request marked denied." },
          { status: 409 },
        );
      }
      shiftInfo = s;
    }
  } else {
    // Denied — just look up the shift for the notification blurb.
    const { data: s } = await supabase
      .from("shifts")
      .select("starts_at, ends_at, position")
      .eq("id", req.shift_id)
      .maybeSingle();
    shiftInfo = s ?? null;
  }

  await supabase.from("shift_requests").update({ status }).eq("id", req.id);

  // Tell the employee the outcome. Wording depends on kind + status.
  const email = await emailForUser(req.employee_id);
  const { data: emp } = await supabase
    .from("profiles")
    .select("phone")
    .eq("id", req.employee_id)
    .maybeSingle();
  const when = shiftInfo
    ? `${fmtDate(shiftInfo.starts_at)} ${fmtTime(shiftInfo.starts_at)}–${fmtTime(shiftInfo.ends_at)}`
    : "your shift";

  let title: string;
  let body: string;
  if (kind === "pickup") {
    title = status === "approved" ? "Shift pickup approved" : "Shift pickup denied";
    body = status === "approved"
      ? `You've been assigned to ${when}.`
      : `Your request to pick up ${when} was denied.`;
  } else {
    title = status === "approved" ? "Shift drop approved" : "Shift drop denied";
    body = status === "approved"
      ? `You've been released from ${when}.`
      : `Your request to drop ${when} was denied. You're still scheduled.`;
  }
  await notify({
    userId: req.employee_id,
    type: kind === "pickup" ? "pickup_decision" : "drop_decision",
    title,
    body,
    phone: emp?.phone ?? null,
    email,
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
