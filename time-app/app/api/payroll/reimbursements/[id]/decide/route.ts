import { approverAction, type ApproverAction } from "@/lib/reimbursements/lifecycle";
import { approverContext } from "@/lib/reimbursements/approverRoute";
import { reasonLabel } from "@/lib/reimbursements/events";
import { emailReceiptsOnApproval, notifyEmployee, todayNY, withAmounts, type ReimbursementRow } from "@/lib/reimbursements/server";
import { money } from "@/lib/payroll/paySheet";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ACTIONS: ApproverAction[] = ["approve", "reject", "send_back", "paid_outside_payroll"];
const MAX_REASON = 500;

// POST /api/payroll/reimbursements/:id/decide
// Body: { action: "approve" | "reject" | "send_back" | "paid_outside_payroll", reason? }
//
// An Approver decides a Travel Reimbursement (bj-finance #210):
//   approve               Submitted -> Approved. Its Receipts go to receipts@ now (30).
//                         No notice to the employee (25).
//   reject                Submitted -> Rejected, with a reason the employee is told.
//   send_back             Approved -> Submitted, until it is Paid (20).
//   paid_outside_payroll  an owner's Approved one, by an owner, paid today (18).
// lib/reimbursements/lifecycle.ts says who may do what; migration 37's guard
// trigger refuses the same in the database.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { action?: unknown; reason?: unknown } | null;
  const action = ACTIONS.find((a) => a === body?.action);
  if (!action) return NextResponse.json({ error: `action must be one of ${ACTIONS.join(", ")}` }, { status: 400 });

  const ctx = await approverContext(params.id);
  if (ctx.res) return ctx.res;
  const { row, subject, rates, supabase } = ctx;

  const step = approverAction(action, row.status, { subject, actor: me });
  if (!step.ok) return NextResponse.json({ error: step.error }, { status: step.forbidden ? 403 : 409 });

  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, MAX_REASON) : "";
  if (action === "reject" && !reason) return NextResponse.json({ error: "Say why it is rejected, so they can fix it." }, { status: 400 });

  const now = new Date().toISOString();
  const patch: Partial<ReimbursementRow> =
    action === "approve"
      ? { status: "approved", decided_by: me.id, decided_at: now }
      : action === "reject"
        ? { status: "rejected", rejection_reason: reason, decided_by: me.id, decided_at: now }
        : action === "send_back"
          ? { status: "submitted" }
          : { status: "paid_outside_payroll", paid_on: todayNY(), paid_by: me.id };

  const { data, error } = await supabase
    .from("travel_reimbursements")
    .update(patch)
    .eq("id", row.id)
    .eq("status", row.status)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  if (!data) return NextResponse.json({ error: "It changed while you were looking. Reload and try again." }, { status: 409 });
  const [updated] = withAmounts([data as ReimbursementRow], rates, row.adjustments);

  let receiptsEmailed = false;
  if (action === "approve") receiptsEmailed = await emailReceiptsOnApproval(updated, subject.full_name ?? "A staff member");
  if (action === "reject")
    await notifyEmployee(
      subject,
      "Travel Reimbursement rejected",
      `Your Travel Reimbursement for ${reasonLabel(updated)}, trip ${updated.trip_date} (${money(updated.amounts.total_cents)}), was rejected: ${reason} Fix it on the Reimbursements page and submit it again.`,
    );
  return NextResponse.json({ reimbursement: updated, receipts_emailed: receiptsEmailed });
}
