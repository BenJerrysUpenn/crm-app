import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { validateFullName, normalizePhone } from "@/lib/profileName";
import { isMissingColumn } from "@/lib/storeHours";
import { parseQboEmployeeId } from "@/lib/payroll/qboEmployee";
import { parsePayType } from "@/lib/payroll/payType";
import { ARCHIVE_NEEDS_MIGRATION, parseArchivedAt } from "@/lib/teamArchive";
import { NextResponse } from "next/server";
import { isManager, profilePatchRefusal } from "@/lib/roles";

// The fields a manager may set on somebody's profile from the Team page.
const EDITABLE = [
  "full_name",
  "phone",
  "role",
  "hourly_rate",
  "active",
  "qbo_employee_id",
  "pay_type",
  "archived_at",
] as const;

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const me = await getProfile();
  if (!me || !isManager(me))
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  const patch: Record<string, unknown> = {};
  for (const k of EDITABLE) {
    if (k in body) patch[k] = body[k];
  }

  // Same rule as POST /api/profiles: a name can be changed but never cleared
  // or replaced with an email address. Validated after the raw copy so the
  // checked value overwrites what the EDITABLE loop put in patch.full_name.
  if ("full_name" in body) {
    const name = validateFullName(body.full_name);
    if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
    patch.full_name = name.name;
  }

  // Same phone rule as the self-edit and POST paths: trim, blank/non-string
  // becomes null. Before this a manager's edit stored the value exactly as
  // typed, so the SMS-alert column held a different shape than a self-edit's.
  if ("phone" in patch) patch.phone = normalizePhone(patch.phone);

  // Owners: a manager cannot edit an owner's row, or give or take away the
  // owner role (lib/roles.ts). Read under the manager's own session, which
  // RLS lets see every profile.
  const supabase = createClient();
  const { data: target } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", params.id)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "No such team member" }, { status: 404 });
  const refusal = profilePatchRefusal(me, target, patch);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 403 });

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

  // Archive (migration 32). true stamps the server's time and takes the person
  // off the schedule in the same update; null unarchives and leaves active as
  // it is, so coming back to the floor is the manager's separate tick.
  if ("archived_at" in patch) {
    const parsed = parseArchivedAt(patch.archived_at, new Date());
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    patch.archived_at = parsed.value;
    if (parsed.value !== null) patch.active = false;
  }

  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();
  // Migration 32 is applied by hand too. Checked first: the whole update is
  // rejected, so active is not set on its own, and the manager is told why.
  if ("archived_at" in patch && isMissingColumn(error, "archived_at"))
    return NextResponse.json({ error: ARCHIVE_NEEDS_MIGRATION }, { status: 503 });
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
