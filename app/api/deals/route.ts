import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasErrors, validateDealPayload } from "@/lib/callDesk/dealForm";
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
import { findDuplicates } from "@/lib/dealDedupe";

export const dynamic = "force-dynamic";

// POST /api/deals
//
// Manual deal intake: the customer did not use the catering form on
// benjerry.com/upenn/catering. They rang, emailed, or asked at the counter,
// and somebody is typing it in.
//
// Differences from POST /api/call-desk/deals, and only these:
//
//   * no prospect. There is nothing to hand off and no outreach_events row.
//   * the human picks the source ('phone' | 'email' | 'walk_in' | 'other').
//     The call desk is always 'phone' and does not ask.
//   * the required set is a name, one contact method, and the source. The
//     rest of the enquiry is usually not known yet.
//   * a duplicate check runs first. It warns; it never blocks (repeat
//     customers are the business). Re-post with `confirm_duplicate: true`
//     to go ahead.
//
// Everything else is identical, on purpose: the same builder, the same
// allowlist guard, the same write gate, the same quote jobs. A manual deal
// is an ordinary deal from the moment it exists, so the board, the sweep,
// the morning report, the picklist and the staffing cron treat it like any
// other. None of them read `source`.
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

  const payload = readPayload(body);
  const maxFlavors = int(body.max_flavors) ?? undefined;
  const errors = validateDealPayload(payload, { maxFlavors, mode: "manual" });
  if (hasErrors(errors))
    return NextResponse.json(
      { error: "Some fields need fixing", field_errors: errors },
      { status: 400 },
    );

  // Advisory duplicate gate. Server-side as well as in the form, because the
  // form's check runs while typing and the deal is created seconds later —
  // two people entering the same voicemail at once is exactly the case a
  // client-only check misses.
  if (body.confirm_duplicate !== true) {
    const dedupe = await findDuplicates(supabase, {
      email: payload.contact_email,
      phone: payload.contact_phone,
    });
    if (dedupe.matches.length > 0) {
      return NextResponse.json(
        {
          error: "This contact already exists",
          duplicates: dedupe.matches,
          // The client re-posts with this set once the human has looked.
          confirm_with: "confirm_duplicate",
        },
        { status: 409 },
      );
    }
  }

  const profileLabel = await profileLabelFor(
    supabase,
    payload.customer_profile,
    str(body.customer_profile_label),
  );

  const plan = planDeal({
    payload,
    prospectId: null,
    callerEmail,
    profileLabel,
  });

  const stray = guardInsert(plan.dealInsert);
  if (stray)
    return NextResponse.json({ error: stray.error }, { status: stray.status });

  if (!writesAreLive()) {
    return NextResponse.json({
      dry_run: true,
      reason: `${WRITE_MODE_ENV} is not "live" — nothing was written`,
      deal_insert: plan.dealInsert,
      quote_jobs: plan.jobs,
      ...(plan.quoteSkippedReason
        ? { quote_skipped: plan.quoteSkippedReason }
        : {}),
    });
  }

  const result = await writeDeal(supabase, plan, {
    prospectId: null,
    callerEmail,
  });
  if (!result.ok)
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );

  return NextResponse.json({
    deal_id: result.dealId,
    quote_job_ids: result.quoteJobIds,
    // Intake's whole Salesforce involvement, echoed so the operator can see
    // that the deal is now in the mirror's queue rather than lost.
    sf_lead_state: plan.dealInsert.sf_lead_state,
    ...(result.quoteSkippedReason
      ? { quote_skipped: result.quoteSkippedReason }
      : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  });
}
