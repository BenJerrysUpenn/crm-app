import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { signedFileRedirect } from "@/lib/reimbursements/fileRoute";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/payroll/reimbursements/file?path=
// The Reimbursements tab opens Receipts and Adjustment evidence here: on
// finance.withers-ventures.com only /api/payroll is served (lib/hosts.ts).
export async function GET(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  return signedFileRedirect(request);
}
