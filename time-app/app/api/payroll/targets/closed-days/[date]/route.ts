import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { deleteException } from "@/lib/storeHoursExceptionRoutes";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// DELETE /api/payroll/targets/closed-days/2026-11-26
// Opens a closed day again from the Targets tab: drops its row in
// store_hours_exceptions, as the Team page does. Managers only. -> { ok }
export async function DELETE(_request: Request, { params }: { params: { date: string } }) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  return deleteException(params.date);
}
