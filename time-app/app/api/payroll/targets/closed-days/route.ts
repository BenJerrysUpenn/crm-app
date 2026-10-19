import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { postException } from "@/lib/storeHoursExceptionRoutes";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POST /api/payroll/targets/closed-days
// Body: { date: "YYYY-MM-DD", label?: string, is_closed?: boolean }
//
// A closed day from the Targets tab (bj-finance #742): a row in
// store_hours_exceptions, the same as the Team page's holidays and special
// days, under /api/payroll so the finance site serves it. Managers only.
// -> { exception: StoreHoursException }
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  return postException(request);
}
