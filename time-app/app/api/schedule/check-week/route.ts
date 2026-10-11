import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { isISODate } from "@/lib/holidays";
import { checkLiveWeekCoverage } from "@/lib/weekCoverage";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// force-dynamic alone does not stop Next caching the fetches a route makes
// (see lib/supabase/admin.ts); this does. A check that replayed an old answer
// would report a gap the manager has already filled.
export const fetchCache = "force-no-store";

// GET /api/schedule/check-week?weekStart=YYYY-MM-DD
// -> 200 { gaps: CoverageGap[], hoursNotSet: HoursNotSetDay[] }
// -> 503 { error: "coverage_unavailable" | "store_hours_not_set_up" }
//
// The "Check week" button: does the live schedule put somebody in the store
// for every opening hour of the week? Managers only. Read-only: no writes, no
// notifications.
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const weekStart = new URL(request.url).searchParams.get("weekStart");
  if (!isISODate(weekStart)) return NextResponse.json({ error: "weekStart (YYYY-MM-DD) required" }, { status: 400 });

  const result = await checkLiveWeekCoverage(createClient(), weekStart);
  if (result.status === "unavailable") return NextResponse.json({ error: "coverage_unavailable" }, { status: 503 });
  if (result.status === "not_migrated") return NextResponse.json({ error: "store_hours_not_set_up" }, { status: 503 });
  return NextResponse.json({ gaps: result.gaps, hoursNotSet: result.hoursNotSet });
}
