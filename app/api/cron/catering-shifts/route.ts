import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inspectBookedDeals, reconcileBookedDeals } from "@/lib/cateringShifts";

export const dynamic = "force-dynamic";

// GET /api/cron/catering-shifts
//
// Reconciles catering draft shifts: any booked deal (unpaid or paid) whose
// picklist has been generated (departure_time is set) but has no shifts yet
// gets its open draft shifts created. This is the path that catches deals whose
// picklist is generated AFTER booking, when the stage-change trigger can't.
//
// Meant to be hit on a schedule, same cadence as the missed-clockins cron.
//
// CRON_SECRET is required, via Bearer header or ?secret=. It is the ONLY thing
// guarding this route: the auth middleware lets /api/cron through, and the
// handler writes with the service-role key, bypassing RLS. An unset secret
// therefore means "open write endpoint", so treat it as misconfiguration and
// refuse rather than defaulting to allow.
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // not configured -> refuse
  const header = request.headers.get("authorization");
  const url = new URL(request.url);
  return header === `Bearer ${secret}` || url.searchParams.get("secret") === secret;
}

export async function GET(request: Request) {
  if (!authorized(request))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const admin = createAdminClient();
    // ?dryRun=1 reports what the sweep sees without inserting anything.
    if (new URL(request.url).searchParams.get("dryRun"))
      return NextResponse.json({ ok: true, dryRun: true, ...(await inspectBookedDeals(admin)) });
    const result = await reconcileBookedDeals(admin);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Reconcile failed" },
      { status: 500 },
    );
  }
}
