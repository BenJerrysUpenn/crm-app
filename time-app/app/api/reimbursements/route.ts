import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { dayKey } from "@/lib/format";
import { isMissingTable } from "@/lib/storeHours";
import { parseReimbursement } from "@/lib/reimbursements/submission";
import { reimbursementCents } from "@/lib/reimbursements/money";
import { NEEDS_MIGRATION, loadRates, notifyApprovers, resolveSubmission } from "@/lib/reimbursements/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/reimbursements
// Body: { reason: { kind: "errands", note } | { kind: "catering_event", event_id, note? },
//         trip_date, mileage: { mode: "typed", miles } | { mode: "destinations", stops, start_at_store, end_at_store },
//         tolls?, parking?, receipt_paths?, no_receipt_confirmed? }
//
// A staff member submits a Travel Reimbursement for one Reason (bj-finance
// #210). It is Submitted; every Approver who may decide it is told. Tolls or
// parking with no Receipt answers 409 { confirm: "no_receipt" } until the
// staff member says yes to "Are you sure there is no receipt?". Destination
// miles are computed here (Routes API), never taken from the browser.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const today = dayKey(new Date().toISOString());
  const parsed = parseReimbursement(await request.json().catch(() => null), { profileId: me.id, today });
  if (!parsed.ok)
    return NextResponse.json(parsed.confirm ? { error: parsed.error, confirm: parsed.confirm } : { error: parsed.error }, {
      status: parsed.confirm ? 409 : 400,
    });

  const supabase = createClient();
  const rates = await loadRates(supabase);
  if (!rates.ok) return NextResponse.json({ error: rates.error }, { status: 503 });
  const resolved = await resolveSubmission(parsed.value, today, rates.rates);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const { data, error } = await supabase
    .from("travel_reimbursements")
    .insert({ profile_id: me.id, status: "submitted", ...resolved.cols })
    .select()
    .single();
  if (isMissingTable(error)) return NextResponse.json({ error: NEEDS_MIGRATION }, { status: 503 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await notifyApprovers(me, data, reimbursementCents(data, rates.rates).total_cents);
  return NextResponse.json({ reimbursement: data });
}
