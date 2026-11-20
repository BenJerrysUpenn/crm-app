import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { uploadPath } from "@/lib/reimbursements/submission";
import { signedUploadResponse } from "@/lib/reimbursements/fileRoute";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/payroll/reimbursements/evidence-url   Body: { reimbursement_id, ext, content_type }
// A one-shot signed upload for an Adjustment's evidence, under
// adjustments/<reimbursement id>/ in the private bucket (ADR 0002). Approvers
// only, here and in the bucket's policy. Evidence is never emailed.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { reimbursement_id?: unknown; ext?: unknown; content_type?: unknown } | null;
  const id = Number(body?.reimbursement_id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Bad reimbursement id" }, { status: 400 });
  const path = uploadPath({ folder: `adjustments/${id}`, kind: "evidence", ext: body?.ext, content_type: body?.content_type });
  if (!path.ok) return NextResponse.json({ error: path.error }, { status: 400 });
  return signedUploadResponse(path.path);
}
