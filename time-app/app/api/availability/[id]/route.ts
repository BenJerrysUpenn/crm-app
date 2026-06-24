import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate } from "@/lib/format";
import { NextResponse } from "next/server";

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const supabase = createClient();

  // Read the row first so we can tell if it was an approved time-off being removed.
  const { data: row } = await supabase
    .from("availability")
    .select("specific_date, is_available, status, request_group, employee_id")
    .eq("id", params.id)
    .maybeSingle();

  // Delete the whole range if this row belongs to a request group.
  let rangeStart = row?.specific_date as string | undefined;
  let rangeEnd = rangeStart;
  if (row?.request_group) {
    const { data: groupRows } = await supabase
      .from("availability")
      .select("specific_date")
      .eq("request_group", row.request_group);
    const dates = (groupRows ?? []).map((r) => r.specific_date as string).sort();
    if (dates.length) {
      rangeStart = dates[0];
      rangeEnd = dates[dates.length - 1];
    }
    const { error } = await supabase
      .from("availability")
      .delete()
      .eq("request_group", row.request_group);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  } else {
    const { error } = await supabase.from("availability").delete().eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // If an APPROVED time-off day was deleted, alert managers (they planned around it).
  if (row && !row.is_available && row.status === "approved") {
    const who = profile.full_name ?? "An employee";
    const when =
      rangeStart && rangeEnd && rangeStart !== rangeEnd
        ? `${fmtDate(rangeStart + "T12:00:00")}–${fmtDate(rangeEnd + "T12:00:00")}`
        : rangeStart
          ? fmtDate(rangeStart + "T12:00:00")
          : "a day";
    const admin = createAdminClient();
    const { data: managers } = await admin
      .from("profiles")
      .select("id, phone")
      .eq("role", "manager")
      .eq("active", true);
    for (const m of managers ?? []) {
      const email = await emailForUser(m.id);
      await notify({
        userId: m.id,
        type: "timeoff_cancelled",
        title: "Approved time off cancelled",
        body: `${who} removed their approved time off for ${when}. They're available to work again.`,
        phone: m.phone ?? null,
        email,
      }).catch(() => {});
    }
  }

  return NextResponse.json({ ok: true });
}

// Manager approves / denies a time-off request.
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const { status } = await request.json();
  if (!["pending", "approved", "denied"].includes(status))
    return NextResponse.json({ error: "Bad status" }, { status: 400 });
  const supabase = createClient();

  // Apply to the whole range if this row is part of a request group.
  const { data: row } = await supabase
    .from("availability")
    .select("request_group")
    .eq("id", params.id)
    .maybeSingle();

  const query = supabase.from("availability").update({ status });
  const { error } = row?.request_group
    ? await query.eq("request_group", row.request_group)
    : await query.eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Tell the employee their request was approved/denied (once for the range).
  if (status === "approved" || status === "denied") {
    const affected = row?.request_group
      ? await supabase
          .from("availability")
          .select("employee_id, specific_date")
          .eq("request_group", row.request_group)
      : await supabase
          .from("availability")
          .select("employee_id, specific_date")
          .eq("id", params.id);
    const rows = affected.data ?? [];
    if (rows.length) {
      const empId = rows[0].employee_id as string;
      const dates = rows.map((r) => r.specific_date as string).sort();
      const when =
        dates[0] === dates[dates.length - 1]
          ? fmtDate(dates[0] + "T12:00:00")
          : `${fmtDate(dates[0] + "T12:00:00")}–${fmtDate(dates[dates.length - 1] + "T12:00:00")}`;
      const email = await emailForUser(empId);
      const { data: emp } = await supabase
        .from("profiles")
        .select("phone")
        .eq("id", empId)
        .maybeSingle();
      await notify({
        userId: empId,
        type: "timeoff_decision",
        title: status === "approved" ? "Time off approved" : "Time off denied",
        body:
          status === "approved"
            ? `Your time off for ${when} is approved.`
            : `Your time off request for ${when} was denied.`,
        phone: emp?.phone ?? null,
        email,
      }).catch(() => {});
    }
  }

  return NextResponse.json({ ok: true });
}
