import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { CATERING_POSITION } from "@/lib/payroll/verify";
import { planEventShift, type EventShiftRow } from "@/lib/payroll/eventShift";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POST: add a punch for a catering event that has no Catering shift on the
// schedule, and the shift it was worked on, in one save (Alina, 2026-10-05).
// Body: { deal_id, employee_id, clock_in_at, clock_out_at }.
//
// The payroll page's "crew didn't punch" card calls this. Crew is a punch on
// the event's Catering shift (lib/payroll/verify.ts eventCrew), so the punch
// is written with that shift's id and the person is the event's crew: its tip
// splits by punches with no payee to pick. Which shift, and its shape, is
// lib/payroll/eventShift.ts: an unassigned slot on the deal is filled,
// otherwise a new Catering shift is made the way the CRM's writer makes one.
//
// Managers only, through the signed-in session, so RLS and the row_audit
// triggers apply exactly as on the Schedule and Timesheets pages. Two writes
// without a transaction: if the punch is refused, the shift write is undone,
// so a failed save leaves the schedule as it was. Nobody is texted: the shift
// is in the past.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const dealId = Number(body?.deal_id);
  const employeeId = typeof body?.employee_id === "string" ? body.employee_id.trim() : "";
  const clockIn = typeof body?.clock_in_at === "string" ? body.clock_in_at : "";
  const clockOut = typeof body?.clock_out_at === "string" ? body.clock_out_at : "";
  if (!Number.isInteger(dealId) || dealId <= 0)
    return NextResponse.json({ error: "deal_id must be a deal's id." }, { status: 400 });
  if (!employeeId) return NextResponse.json({ error: "Pick who the punch is for." }, { status: 400 });
  const inMs = Date.parse(clockIn);
  const outMs = Date.parse(clockOut);
  if (Number.isNaN(inMs) || Number.isNaN(outMs))
    return NextResponse.json({ error: "A punch added after the fact needs its clock-in and clock-out." }, { status: 400 });
  if (outMs <= inMs) return NextResponse.json({ error: "Clock-out must be after clock-in." }, { status: 400 });

  const supabase = createClient();
  const { data: deal, error: dealError } = await supabase
    .from("deals")
    .select("id, company, venue_name, venue_address")
    .eq("id", dealId)
    .maybeSingle();
  if (dealError) return NextResponse.json({ error: dealError.message }, { status: 400 });
  if (!deal) return NextResponse.json({ error: `No deal ${dealId}.` }, { status: 404 });

  const { data: existing, error: shiftsError } = await supabase
    .from("shifts")
    .select("id, employee_id, deal_slot")
    .eq("deal_id", dealId)
    .eq("position", CATERING_POSITION);
  if (shiftsError) return NextResponse.json({ error: shiftsError.message }, { status: 400 });

  const plan = planEventShift({
    deal,
    eventShifts: (existing ?? []) as EventShiftRow[],
    employeeId,
    clockInAt: new Date(inMs).toISOString(),
    clockOutAt: new Date(outMs).toISOString(),
  });

  let shiftId: number;
  let undo: () => Promise<unknown>;
  if (plan.action === "assign") {
    const { data, error } = await supabase
      .from("shifts")
      .update({ employee_id: employeeId, published: true, updated_at: new Date().toISOString() })
      .eq("id", plan.shiftId)
      .is("employee_id", null)
      .select("id")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data) return NextResponse.json({ error: "That Catering slot was just filled. Verify again." }, { status: 409 });
    shiftId = plan.shiftId;
    undo = async () => supabase.from("shifts").update({ employee_id: null }).eq("id", shiftId);
  } else {
    const { data, error } = await supabase.from("shifts").insert(plan.row).select("id").single();
    if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not add the shift." }, { status: 400 });
    shiftId = (data as { id: number }).id;
    undo = async () => supabase.from("shifts").delete().eq("id", shiftId);
  }

  const { data: entry, error: entryError } = await supabase
    .from("time_entries")
    .insert({
      employee_id: employeeId,
      clock_in_at: new Date(inMs).toISOString(),
      clock_out_at: new Date(outMs).toISOString(),
      status: "closed",
      manual: true,
      shift_id: shiftId,
    })
    .select()
    .single();
  if (entryError || !entry) {
    await undo();
    return NextResponse.json({ error: entryError?.message ?? "Could not add the punch." }, { status: 400 });
  }
  return NextResponse.json({ entry, shift_id: shiftId, shift: plan.action === "assign" ? "filled" : "created" });
}
