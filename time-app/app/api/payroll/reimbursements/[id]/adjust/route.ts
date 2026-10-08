import { ADJUSTMENT_FIELDS, approverAction } from "@/lib/reimbursements/lifecycle";
import { approverContext } from "@/lib/reimbursements/approverRoute";
import { centsFromDollars } from "@/lib/reimbursements/money";
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
// file (uploaded first through evidence-url) and a one-line note. The old
// amount is kept in travel_reimbursement_adjustments and shown beside the new
// one; the employee is told old, new and the note. The mileage amount replaces
// the computed one (mileage_cents_override). The evidence never goes to receipts@.
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

  const oldCents = field === "mileage" ? (row.amounts.mileage_cents ?? 0) : field === "tolls" ? row.tolls_cents : row.parking_cents;
  if (oldCents === newCents) return NextResponse.json({ error: `${field[0].toUpperCase()}${field.slice(1)} is already ${money(newCents)}.` }, { status: 400 });

  const { data: adj, error: adjErr } = await supabase
    .from("travel_reimbursement_adjustments")
    .insert({ reimbursement_id: row.id, field, old_cents: oldCents, new_cents: newCents, note, evidence_path: evidence, adjusted_by: me.id })
    .select()
    .single();
  if (adjErr) return NextResponse.json({ error: adjErr.message }, { status: 409 });

  const column = field === "mileage" ? "mileage_cents_override" : field === "tolls" ? "tolls_cents" : "parking_cents";
  const { data, error } = await supabase
    .from("travel_reimbursements")
    .update({ [column]: newCents })
    .eq("id", row.id)
    .eq("status", row.status)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  if (!data) return NextResponse.json({ error: "It changed while you were looking. Reload and try again." }, { status: 409 });
  const [updated] = withAmounts([data as ReimbursementRow], rates, [...row.adjustments, adj as AdjustmentRow]);

  await notifyEmployee(
    subject,
    "Travel Reimbursement adjusted",
    `Your Travel Reimbursement for ${reasonLabel(updated)}, trip ${updated.trip_date}: ${adjustmentText(adj as AdjustmentRow)}. Total now ${money(updated.amounts.total_cents)}.`,
  );
  return NextResponse.json({ reimbursement: updated });
}
