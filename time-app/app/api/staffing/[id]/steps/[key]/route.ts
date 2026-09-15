import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { siteOrigin } from "@/lib/authLinks";
import { completeManualStep, reopenStep } from "@/lib/staffing/execute";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// PATCH /api/staffing/:id/steps/:key
// Manager-only. Marks a manual step done or skipped, with an optional note,
// and applies the step's side effect (fob id -> staff_cards, QBO eeid ->
// profile, Workforce finished -> has_workforce). Body { reopen: true } puts
// a manual step back to pending.
export async function PATCH(
  request: Request,
  { params }: { params: { id: string; key: string } },
) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const body = await request.json().catch(() => ({}));

  const r = body.reopen === true
    ? await reopenStep(id, params.key)
    : await completeManualStep(
        id,
        params.key,
        {
          note: typeof body.note === "string" ? body.note : null,
          skipped: body.skipped === true,
          fob_card_id: typeof body.fob_card_id === "string" ? body.fob_card_id : null,
          qbo_employee_id: typeof body.qbo_employee_id === "string" ? body.qbo_employee_id : null,
        },
        { me, origin: siteOrigin(request) },
      );
  if (r.error) return NextResponse.json({ error: r.error }, { status: r.rec ? 400 : 404 });
  return NextResponse.json({ ok: true, record: r.rec });
}
