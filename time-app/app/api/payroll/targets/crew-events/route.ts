import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { isOwner } from "@/lib/roles";
import { parseCrewInput } from "@/lib/controlBoard/planningInputs";
import { addEventRevision, DATED_TABLES } from "@/lib/controlBoard/save";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POST /api/payroll/targets/crew-events
// Body: { event_key?, name, day, crew_hours, cancelled?, effective_from, review_by, source, method? }
//
// A crew event (Free Cone Day) revision from the Targets tab (bj-finance #742, migration 47).
// No event_key adds a new event; an event_key on file adds a revision of that
// event, in force from effective_from. The old revision stays in the history;
// cancelled: true takes the event off. Owners only; managers see the events
// read-only. The database refuses a non-owner too.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  if (!isOwner(me)) return NextResponse.json({ error: DATED_TABLES.crew_events.ownersOnly }, { status: 403 });

  const body = await request.json().catch(() => null);
  return addEventRevision(createClient(), "crew_events", body, parseCrewInput);
}
