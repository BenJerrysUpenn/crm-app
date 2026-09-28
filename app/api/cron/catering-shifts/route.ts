import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileBookedDeals } from "@/lib/cateringShifts";
import { checkCronSecret } from "@/lib/cronAuth";

export const dynamic = "force-dynamic";
// force-dynamic alone does not stop Next 14 caching the GETs this route makes
// through supabase-js: the deals query is the same URL on every run, so the
// first answer would be served back for a year and a deal booked later would
// never be seen. The time-app's missed-clockins cron hit exactly this
// (time-app/lib/supabase/admin.ts). Both are here on purpose.
export const fetchCache = "force-no-store";

// GET /api/cron/catering-shifts
//
// Reconciles catering draft shifts: any booked deal (unpaid or paid) whose
// picklist has been generated (departure_time is set) but has no shifts yet
// gets its open draft shifts created. This is the path that catches deals whose
// picklist is generated AFTER booking, when the stage-change trigger can't.
//
// Meant to be hit on a schedule. It is the one CRM route a scheduler reaches
// without a login (middleware.ts exempts exactly this path), so CRON_SECRET is
// REQUIRED and the guard fails closed (lib/cronAuth.ts):
//   CRON_SECRET unset          -> 503, nothing read or written
//   wrong or missing secret    -> 401, nothing read or written
//   Bearer header or ?secret=  -> the sweep runs
export async function GET(request: Request) {
  const auth = checkCronSecret(request, process.env.CRON_SECRET);
  if (auth === "unconfigured")
    return NextResponse.json(
      { error: "CRON_SECRET is not configured; this endpoint is disabled" },
      { status: 503 },
    );
  if (auth === "unauthorized")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const admin = createAdminClient();
    const result = await reconcileBookedDeals(admin);
    // A deal asking for a 15+ hour shift per person is almost certainly a bad
    // number upstream. The shifts are created either way, but the sweep says so
    // — in the response and in the cron log, which is where anyone looks first.
    if (result.warnings.length > 0) {
      console.warn("[catering-shifts] implausible shift hours:", result.warnings.join(" | "));
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Reconcile failed" },
      { status: 500 },
    );
  }
}
