import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { isMissingColumn } from "@/lib/storeHours";
import { parseQboEmployeeId } from "@/lib/payroll/qboEmployee";
import { parsePayType } from "@/lib/payroll/payType";
import { NextResponse } from "next/server";

// The fields a manager may set on somebody's profile from the Team page.
const EDITABLE = ["full_name", "phone", "role", "hourly_rate", "active", "qbo_employee_id", "pay_type"] as const;

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  const patch: Record<string, unknown> = {};
  for (const k of EDITABLE) {
    if (k in body) patch[k] = body[k];
  }

  // The QBO employee id is the payroll roster join (spec 2.5), so it is
  // validated rather than stored as typed: a blank becomes null (the unique
  // index is partial on "not null", and an empty string would sit in it
  // pretending to be a mapping), and a pasted email or name is refused here
  // instead of being discovered on pay day.
  if ("qbo_employee_id" in patch) {
    const parsed = parseQboEmployeeId(patch.qbo_employee_id);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    patch.qbo_employee_id = parsed.value;
  }

  // Salaried or hourly (ruled 2026-09-22 on bj-finance #519). The payroll
  // sheet reads it, so only the two words the database CHECK allows get
  // through, and a blank is "not set" rather than a guess.
  if ("pay_type" in patch) {
    const parsed = parsePayType(patch.pay_type);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    patch.pay_type = parsed.value;
  }

  const supabase = createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();
  // Migration 26 is applied by hand, so a deploy can land ahead of it. Saying
  // so beats a raw schema-cache error, and the rest of the row is untouched
  // because the update is rejected whole.
  if (isMissingColumn(error, "qbo_employee_id") || isMissingColumn(error, "pay_type"))
    return NextResponse.json(
      { error: "QBO employee id and pay type need migration 26. Run it in Supabase first." },
      { status: 503 },
    );
  // The partial unique index on qbo_employee_id. Two people on one QBO employee
  // means somebody gets paid twice and somebody not at all, so say which
  // constraint bit rather than showing the manager a Postgres string.
  if (error?.code === "23505" && "qbo_employee_id" in patch)
    return NextResponse.json(
      { error: "That QuickBooks employee id is already on another team member." },
      { status: 409 },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ profile: data });
}
