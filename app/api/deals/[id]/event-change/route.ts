import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  applyEventChange,
  canChangeEvent,
  parseEventChangeBody,
  supabaseEventChangeStore,
} from "@/lib/eventChange";

// /api/deals/:id/event-change: the drawer's Reschedule event and Cancel event
// (rules and every write: lib/eventChange.ts).
//
// GET  what the dialog shows before anyone confirms: the event's date and
//      times, the amount paid, and every crew shift with the person on it.
// POST the change. Body: see parseEventChangeBody. Answers 409 when the crew
//      or the deal changed since the dialog read them.
//
// Service-role client, as the booked-shifts route: shifts and the calendar
// queue are outside the CRM user's RLS. The middleware's role gate keeps
// everyone but managers and owners out.

async function signedInEmail(): Promise<string | null | undefined> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return undefined;
  return user.email ?? null;
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  if ((await signedInEmail()) === undefined)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const dealId = Number(params.id);
  if (!Number.isFinite(dealId))
    return NextResponse.json({ error: "Bad deal id" }, { status: 400 });

  const store = supabaseEventChangeStore(createAdminClient());
  try {
    const deal = await store.readDeal(dealId);
    if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });
    const shifts = await store.readCrewShifts(dealId);
    return NextResponse.json({
      deal: {
        id: deal.id,
        stage: deal.stage,
        can_change: canChangeEvent(deal.stage),
        event_date: deal.event_date,
        event_start_time: deal.event_start_time,
        event_end_time: deal.event_end_time,
        amount_paid: deal.amount_paid,
        has_calendar_event: Boolean(deal.calendar_event_id),
      },
      shifts,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not read the event" },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const email = await signedInEmail();
  if (email === undefined)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const dealId = Number(params.id);
  if (!Number.isFinite(dealId))
    return NextResponse.json({ error: "Bad deal id" }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const parsed = parseEventChangeBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const result = await applyEventChange(
      supabaseEventChangeStore(createAdminClient()),
      dealId,
      parsed.request,
      parsed.staffedShiftIds,
      { now: new Date(), actor: email ?? "unknown" },
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "The change failed" },
      { status: 500 },
    );
  }
}
