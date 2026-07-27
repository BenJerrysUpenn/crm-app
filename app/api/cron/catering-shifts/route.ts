import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileBookedDeals } from "@/lib/cateringShifts";

export const dynamic = "force-dynamic";

// GET /api/cron/catering-shifts
//
// Reconciles catering draft shifts: any booked deal (unpaid or paid) whose
// picklist has been generated (departure_time is set) but has no shifts yet
// gets its open draft shifts created. This is the path that catches deals whose
// picklist is generated AFTER booking, when the stage-change trigger can't.
//
// Meant to be hit on a schedule, same cadence as the missed-clockins cron.
// Optional CRON_SECRET guard: if set, require it via Bearer header or ?secret=.
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured -> allow
  const header = request.headers.get("authorization");
  const url = new URL(request.url);
  return header === `Bearer ${secret}` || url.searchParams.get("secret") === secret;
}

export async function GET(request: Request) {
  if (!authorized(request))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const admin = createAdminClient();
    const result = await reconcileBookedDeals(admin);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Reconcile failed" },
      { status: 500 },
    );
  }
}
