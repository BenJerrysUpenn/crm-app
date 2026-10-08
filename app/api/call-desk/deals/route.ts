import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  hasErrors,
  validateDealPayload,
  DEAL_SOURCE,
} from "@/lib/callDesk/dealForm";
import {
  guardInsert,
  planDeal,
  writeDeal,
  writesAreLive,
  WRITE_MODE_ENV,
} from "@/lib/callDesk/dealCreate";
import {
  int,
  profileLabelFor,
  readPayload,
  str,
} from "@/lib/callDesk/dealRequest";

export const dynamic = "force-dynamic";

// POST /api/call-desk/deals
//
// Body: the guided-form payload + `prospect_id` (+ `customer_profile`, which is
// part of the payload). Creates the deal on the canonical write path —
// Catering-Manager/v2/modules/db.py::create_deal(source='phone') — then records
// the hand-off on the prospect and enqueues the worker jobs.
//
// Default response is a DRY RUN: the exact rows that would be written, nothing
// touched. Set CALL_DESK_DEAL_WRITES=live to actually write.
//
// A deal typed by hand with NO prospect behind it goes to POST /api/deals
// instead; this route keeps requiring a prospect, because handing a prospect
// off is half of what it does.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const callerEmail = user.email ?? "";
  if (!callerEmail)
    return NextResponse.json(
      { error: "Signed-in user has no email address" },
      { status: 401 },
    );

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const prospectId = int(body.prospect_id);
  if (prospectId == null || prospectId <= 0)
    return NextResponse.json(
      { error: "prospect_id required" },
      { status: 400 },
    );

  // The call desk is always the phone channel, whatever the body claims.
  const payload = { ...readPayload(body), source: DEAL_SOURCE };
  const maxFlavors = int(body.max_flavors) ?? undefined;
  const errors = validateDealPayload(payload, { maxFlavors, mode: "call_desk" });
  if (hasErrors(errors))
    return NextResponse.json(
      { error: "Some fields need fixing", field_errors: errors },
      { status: 400 },
    );

  const profileLabel = await profileLabelFor(
    supabase,
    payload.customer_profile,
    str(body.customer_profile_label),
  );

  const plan = planDeal({ payload, prospectId, callerEmail, profileLabel });

  // Defensive allowlist guard, mirroring db.py::validate_deal_update_fields:
  // reject the whole request rather than silently dropping a stray column.
  const stray = guardInsert(plan.dealInsert);
  if (stray)
    return NextResponse.json({ error: stray.error }, { status: stray.status });

  if (!writesAreLive()) {
    return NextResponse.json({
      dry_run: true,
      reason: `${WRITE_MODE_ENV} is not "live" — nothing was written`,
      deal_insert: plan.dealInsert,
      events: plan.events,
      prospect_update: {
        table: "outreach_prospects",
        id: prospectId,
        status: "handed_off",
        updated_at: "now()",
      },
      quote_jobs: plan.jobs,
    });
  }

  const result = await writeDeal(supabase, plan, { prospectId, callerEmail });
  if (!result.ok)
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );

  return NextResponse.json({
    deal_id: result.dealId,
    quote_job_ids: result.quoteJobIds,
    ...(result.quoteSkippedReason
      ? { quote_skipped: result.quoteSkippedReason }
      : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  });
}
