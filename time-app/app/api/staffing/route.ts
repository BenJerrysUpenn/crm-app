import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import { siteOrigin } from "@/lib/authLinks";
import { parseOffboarding, parseOnboarding, parsePayrollSetup, todayET } from "@/lib/staffing/forms";
import { createLifecycle, loadLifecycle, runAutoSteps } from "@/lib/staffing/execute";
import type { LifecycleKind } from "@/lib/types";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POST /api/staffing
// Manager-only. Body: { kind: 'onboarding'|'payroll_setup'|'offboarding', ...form }
// Creates the record and its steps, then runs the automatic steps unless the
// offboarding's last day is still ahead (those wait for the Run button).
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const kind = body.kind as LifecycleKind;
  const admin = createAdminClient();
  const actor = { me, origin: siteOrigin(request) };

  let created: { id: number } | { error: string };
  let runNow = true;

  if (kind === "onboarding") {
    const p = parseOnboarding(body);
    if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
    created = await createLifecycle(admin, {
      kind,
      form: p.form,
      employee_id: null,
      created_by: me.id,
    });
  } else if (kind === "payroll_setup") {
    const p = parsePayrollSetup(body);
    if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
    const { data: prof } = await admin
      .from("profiles")
      .select("id")
      .eq("id", p.form.employee_id)
      .maybeSingle();
    if (!prof) return NextResponse.json({ error: "No such team member" }, { status: 400 });
    created = await createLifecycle(admin, {
      kind,
      form: p.form,
      employee_id: p.form.employee_id,
      created_by: me.id,
    });
  } else if (kind === "offboarding") {
    const employee_id = typeof body.employee_id === "string" ? body.employee_id : "";
    let lookup: { name: string; email: string | null } | null = null;
    if (employee_id) {
      const { data: prof } = await admin
        .from("profiles")
        .select("id, full_name")
        .eq("id", employee_id)
        .maybeSingle();
      if (prof) {
        const { data: u } = await admin.auth.admin.getUserById(employee_id);
        lookup = {
          name: (prof.full_name as string | null) ?? u.user?.email ?? employee_id,
          email: u.user?.email ?? null,
        };
      }
    }
    const p = parseOffboarding(body, lookup);
    if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
    if (p.form.employee_id === me.id)
      return NextResponse.json({ error: "You cannot offboard yourself" }, { status: 400 });
    created = await createLifecycle(admin, {
      kind,
      form: p.form,
      employee_id: p.form.employee_id,
      created_by: me.id,
    });
    // Access removal waits until the last day has arrived, unless the
    // manager says run now (a no-show, someone let go on the spot).
    runNow = body.run_now === true || p.form.last_day <= todayET();
  } else {
    return NextResponse.json({ error: "Unknown form kind" }, { status: 400 });
  }

  if ("error" in created)
    return NextResponse.json({ error: created.error }, { status: 400 });

  const rec = runNow
    ? await runAutoSteps(created.id, actor)
    : await loadLifecycle(admin, created.id);
  return NextResponse.json({ ok: true, record: rec, ran: runNow });
}
