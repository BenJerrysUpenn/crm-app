import { ADJUSTMENT_FIELDS, FIELD_LABEL, approverAction } from "@/lib/reimbursements/lifecycle";
import { CHANGED, approverContext } from "@/lib/reimbursements/approverRoute";
import { centsFromDollars, fieldCents } from "@/lib/reimbursements/money";
import { BUCKET } from "@/lib/reimbursements/submission";
import { reasonLabel } from "@/lib/reimbursements/events";
import { adjustmentText, notifyEmployee, withAmounts, type AdjustmentRow, type ReimbursementRow } from "@/lib/reimbursements/server";
import { money } from "@/lib/payroll/paySheet";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const MAX_NOTE = 300;

// POST /api/payroll/reimbursements/:id/adjust
// Body: { field: "mileage" | "tolls" | "parking", amount, note, evidence_path }
//
// An Adjustment (bj-finance #210, rulings 29, 34-36): an Approver changes one
// amount of a Submitted or Approved Travel Reimbursement, backed by an evidence
// file (uploaded first through evidence-url, and refused unless it is there)
// and a one-line note. The old amount is kept in travel_reimbursement_adjustments
// and shown beside the new one; the employee is told old, new and the note. The
// mileage amount replaces the computed one (mileage_cents_override). The
// evidence never goes to receipts@.
//
// The amount and its Adjustment are written together by migration 37's
// adjust_travel_reimbursement(), and only if the row is still as this Approver
// read it: a reimbursement decided or adjusted meanwhile is refused (409) and
// leaves no Adjustment behind.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const field = ADJUSTMENT_FIELDS.find((f) => f === body?.field);
  if (!field) return NextResponse.json({ error: "Pick the amount to adjust: mileage, tolls or parking." }, { status: 400 });
  const newCents = centsFromDollars(body?.amount);
  if (newCents == null || (typeof body?.amount === "string" && body.amount.trim() === ""))
    return NextResponse.json({ error: "Give the new amount in dollars, like 5.00." }, { status: 400 });
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (!note || note.length > MAX_NOTE || note.includes("\n"))
    return NextResponse.json({ error: `Add a one-line note (up to ${MAX_NOTE} characters) saying what settled it.` }, { status: 400 });

  const ctx = await approverContext(params.id);
  if (ctx.res) return ctx.res;
  const { row, subject, rates, supabase } = ctx;

  const evidence = typeof body?.evidence_path === "string" ? body.evidence_path : "";
  if (!evidence.startsWith(`adjustments/${row.id}/`) || evidence.includes(".."))
    return NextResponse.json({ error: "Upload the evidence (e.g. a screenshot of the conversation) first." }, { status: 400 });

  const step = approverAction("adjust", row.status, { subject, actor: me });
  if (!step.ok) return NextResponse.json({ error: step.error }, { status: step.forbidden ? 403 : 409 });

  // Mileage with no rate for the trip date has no computed amount: it was $0.00.
  const oldCents = fieldCents(row.amounts, field) ?? 0;
  if (oldCents === newCents) return NextResponse.json({ error: `${FIELD_LABEL[field]} is already ${money(newCents)}.` }, { status: 400 });

  let uploaded: boolean;
  try {
    uploaded = (await supabase.storage.from(BUCKET).exists(evidence)).data;
  } catch (e) {
    return NextResponse.json({ error: `The evidence could not be checked in Storage: ${e instanceof Error ? e.message : String(e)}` }, { status: 503 });
  }
  if (!uploaded) return NextResponse.json({ error: "That evidence file was never uploaded. Attach it again." }, { status: 400 });

  const { data, error } = await supabase.rpc("adjust_travel_reimbursement", {
    p_id: row.id,
    p_seen_updated_at: row.updated_at,
    p_field: field,
    p_old_cents: oldCents,
    p_new_cents: newCents,
    p_note: note,
    p_evidence_path: evidence,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  if (!data) return NextResponse.json({ error: CHANGED }, { status: 409 });
  const { reimbursement, adjustment } = data as { reimbursement: ReimbursementRow; adjustment: AdjustmentRow };
  const [updated] = withAmounts([reimbursement], rates, [...row.adjustments, adjustment]);

  await notifyEmployee(
    subject,
    "Travel Reimbursement adjusted",
    `Your Travel Reimbursement for ${reasonLabel(updated)}, trip ${updated.trip_date}: ${adjustmentText(adjustment)}. Total now ${money(updated.amounts.total_cents)}.`,
  );
  return NextResponse.json({ reimbursement: updated });
}
