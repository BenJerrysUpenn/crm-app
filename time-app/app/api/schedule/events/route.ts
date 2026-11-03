import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { isISODate } from "@/lib/holidays";
import { isManager } from "@/lib/roles";
import { loadScheduleEvents } from "@/lib/shiftEventLink";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// force-dynamic alone does not stop Next caching the fetches a route makes
// (see lib/supabase/admin.ts); this does.
export const fetchCache = "force-no-store";

// GET /api/schedule/events?date=YYYY-MM-DD -> 200 { events }
// The event dropdown, for a shift moved to a date outside the week on screen (the
// page already has that week's). Every position's events: the popup keeps the
// ones its position takes. Managers only. Read-only.
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !isManager(profile))
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const date = new URL(request.url).searchParams.get("date");
  if (!isISODate(date)) return NextResponse.json({ error: "date (YYYY-MM-DD) required" }, { status: 400 });

  const events = await loadScheduleEvents(createClient(), date, date);
  if (events === null) return NextResponse.json({ error: "events_unavailable" }, { status: 503 });
  return NextResponse.json({ events });
}
