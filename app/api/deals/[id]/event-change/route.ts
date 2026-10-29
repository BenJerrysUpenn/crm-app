import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  applyEventChange,
  parseEventChangeBody,
  readEventPreview,
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

/**
 * The guards both handlers run first, in this order: a signed-in user (401),
 * then a numeric deal id (400). The refusal is the response to return.
 */
async function signedInDealRequest(
  id: string,
): Promise<{ email: string | null; dealId: number } | NextResponse> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const dealId = Number(id);
  if (!Number.isFinite(dealId))
    return NextResponse.json({ error: "Bad deal id" }, { status: 400 });
  return { email: user.email ?? null, dealId };
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const caller = await signedInDealRequest(params.id);
  if (caller instanceof NextResponse) return caller;
  const { dealId } = caller;

  const store = supabaseEventChangeStore(createAdminClient());
  try {
    const preview = await readEventPreview(store, dealId);
    if (!preview) return NextResponse.json({ error: "Deal not found" }, { status: 404 });
    return NextResponse.json(preview);
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
  const caller = await signedInDealRequest(params.id);
  if (caller instanceof NextResponse) return caller;
  const { email, dealId } = caller;

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
      parsed,
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
