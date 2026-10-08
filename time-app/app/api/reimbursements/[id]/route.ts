import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { dayKey } from "@/lib/format";
import { isMissingTable } from "@/lib/storeHours";
import { parseReimbursement } from "@/lib/reimbursements/submission";
import { reimbursementCents } from "@/lib/reimbursements/money";
import { staffMayChange } from "@/lib/reimbursements/lifecycle";
import { NEEDS_MIGRATION, loadRates, notifyApprovers, resolveSubmission, type ReimbursementRow } from "@/lib/reimbursements/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const LOCKED = "Only a Submitted or Rejected Travel Reimbursement can be changed. Ask an Approver to send an Approved one back.";

type Params = { params: { id: string } };

/** The signed-in staff member's own reimbursement, or the response that says why not. */
async function own(params: Params["params"]) {
  const me = await getProfile();
  if (!me) return { res: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return { res: NextResponse.json({ error: "Bad id" }, { status: 400 }) };
  const supabase = createClient();
  const { data, error } = await supabase.from("travel_reimbursements").select("*").eq("id", id).maybeSingle();
  if (isMissingTable(error)) return { res: NextResponse.json({ error: NEEDS_MIGRATION }, { status: 503 }) };
  if (error) return { res: NextResponse.json({ error: error.message }, { status: 400 }) };
  const row = data as ReimbursementRow | null;
  if (!row || row.profile_id !== me.id) return { res: NextResponse.json({ error: "Travel Reimbursement not found" }, { status: 404 }) };
  if (!staffMayChange(row.status)) return { res: NextResponse.json({ error: LOCKED }, { status: 409 }) };
  return { me, row, supabase };
}

// PATCH /api/reimbursements/:id   Body: as POST /api/reimbursements.
// The staff member edits their own while Submitted, or fixes a Rejected one,
// which resubmits it (bj-finance #210, ruling 20). Changing the miles drops an
// Adjustment's mileage amount: the new miles need deciding again. A
// resubmission tells the Approvers, as a new submission does.
export async function PATCH(request: Request, { params }: Params) {
  const found = await own(params);
  if (found.res) return found.res;
  const { me, row, supabase } = found;

  const today = dayKey(new Date().toISOString());
  const parsed = parseReimbursement(await request.json().catch(() => null), { profileId: me.id, today });
  if (!parsed.ok)
    return NextResponse.json(parsed.confirm ? { error: parsed.error, confirm: parsed.confirm } : { error: parsed.error }, {
      status: parsed.confirm ? 409 : 400,
    });
  const rates = await loadRates(supabase);
  if (!rates.ok) return NextResponse.json({ error: rates.error }, { status: 503 });
  const resolved = await resolveSubmission(parsed.value, today, rates.rates);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const milesChanged = Number(resolved.cols.miles) !== Number(row.miles);
  const { data, error } = await supabase
    .from("travel_reimbursements")
    .update({
      ...resolved.cols,
      status: "submitted",
      ...(milesChanged ? { mileage_cents_override: null } : {}),
    })
    .eq("id", row.id)
    .eq("status", row.status)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  if (!data) return NextResponse.json({ error: LOCKED }, { status: 409 });

  if (row.status === "rejected") await notifyApprovers(me, data, reimbursementCents(data, rates.rates).total_cents);
  return NextResponse.json({ reimbursement: data });
}

// DELETE /api/reimbursements/:id
// The staff member deletes their own while Submitted or Rejected (ruling 20).
// Its uploaded files stay in the bucket.
export async function DELETE(_request: Request, { params }: Params) {
  const found = await own(params);
  if (found.res) return found.res;
  const { row, supabase } = found;
  const { data, error } = await supabase.from("travel_reimbursements").delete().eq("id", row.id).eq("status", row.status).select();
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  if (!data?.length) return NextResponse.json({ error: LOCKED }, { status: 409 });
  return NextResponse.json({ ok: true });
}
