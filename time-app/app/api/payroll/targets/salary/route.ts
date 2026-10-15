import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { isOwner } from "@/lib/roles";
import { parseSalaryInput } from "@/lib/controlBoard/settings";
import { addDatedRow, DATED_TABLES } from "@/lib/controlBoard/save";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POST /api/payroll/targets/salary
// Body: { profile_id, annual_salary, effective_from, review_by, source, method? }
//
// Adds a dated annual salary for a salaried person, from the Team page
// (bj-finance #693). Like every control-board value, a change is a new row in
// force from effective_from; the old salary stays in the history (migration
// 43). The control board's fixed payroll is built from these. Owners only.
// Under /api/payroll so the finance host would serve it too (lib/hosts.ts).
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  if (!isOwner(me)) return NextResponse.json({ error: DATED_TABLES.profile_salaries.ownersOnly }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = parseSalaryInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const supabase = createClient();
  const { data: person } = await supabase
    .from("profiles")
    .select("id, pay_type")
    .eq("id", parsed.value.profile_id)
    .maybeSingle();
  if (!person) return NextResponse.json({ error: "No such person." }, { status: 404 });
  if (person.pay_type !== "salaried")
    return NextResponse.json({ error: "Set their Pay to Salaried on the Team page first." }, { status: 400 });

  return addDatedRow(supabase, "profile_salaries", parsed.value);
}
