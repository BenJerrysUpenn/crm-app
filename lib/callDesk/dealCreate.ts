// The one place a deal is written into `deals` from the CRM.
//
// Two intakes share it: the call desk's "Generate deal" (a prospect is in
// hand, source is always 'phone') and the manual "New deal" form (no prospect,
// the human picks the source). They differ only in what they know, not in what
// they write, so the write itself lives here and each route stays a thin
// HTTP wrapper.
//
// Extracted from app/api/call-desk/deals/route.ts without behaviour change:
// the same rows, in the same order, with the same dry run and the same
// degrade-to-warning posture after the deal insert.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildDealInsert,
  disallowedInsertKeys,
  isQuoteReady,
  type DealFormPayload,
  type DealInsert,
} from "@/lib/callDesk/dealForm";

// Write gate. The human has not ruled on the write mechanism yet (#409), and
// the prototype standard is dry-run all the way to the prod boundary, so the
// routes compute every row and return them without writing unless this env
// var is explicitly "live". One gate for both intakes: a single flip turns
// deal creation on, and there is no state where one form writes and the other
// pretends to.
export const WRITE_MODE_ENV = "CALL_DESK_DEAL_WRITES";

export function writesAreLive(): boolean {
  return process.env[WRITE_MODE_ENV] === "live";
}

// The worker must re-triage (drive time, staff, labor) before it can price, so
// the jobs go in this order; the Mac-side worker processes quote_jobs by id.
export const JOB_KINDS = ["retriage", "quote"] as const;

export type QuoteJobInsert = {
  deal_id: number | null;
  status: "pending";
  kind: (typeof JOB_KINDS)[number];
  requested_by: string;
};

export type OutreachEventInsert = {
  prospect_id: number;
  event: "deal_created" | "handed_off";
  detail: Record<string, unknown>;
};

export type CreateDealArgs = {
  payload: DealFormPayload;
  /** The call-desk prospect behind this deal, or null for manual intake. */
  prospectId: number | null;
  callerEmail: string;
  profileLabel: string;
  nowUtc?: Date;
};

export type CreateDealPlan = {
  dealInsert: DealInsert;
  events: OutreachEventInsert[];
  jobs: QuoteJobInsert[];
  /** Why no quote job was planned, or null when jobs were. Surfaced to the
   *  caller so an operator is never left wondering where the quote went. */
  quoteSkippedReason: string | null;
};

export const QUOTE_SKIPPED_INCOMPLETE =
  "No quote job queued: the deal still needs a venue address, an event date, " +
  "a guest count and a package before it can be priced. Fill those in on the " +
  "board and the quote can be requested then.";

export type CreateDealFailure = { ok: false; status: number; error: string };
export type CreateDealSuccess = {
  ok: true;
  dealId: number;
  quoteJobIds: number[];
  quoteSkippedReason: string | null;
  warnings: string[];
};

// PostgREST / Postgres "column does not exist". Raised when Catering-Manager
// migration 023 has not been applied yet, which is a human step.
const UNDEFINED_COLUMN = "42703";
export const MIGRATION_023_MISSING =
  "The deals table is missing the manual-intake columns. Apply " +
  "Catering-Manager migrations/023_manual_deal_sources_and_sf_lead_state.sql " +
  "in the Supabase SQL editor, then try again.";

/** Compute every row this deal implies. Pure apart from the clock. */
export function planDeal(args: CreateDealArgs): CreateDealPlan {
  const dealInsert = buildDealInsert(args.payload, {
    callerEmail: args.callerEmail,
    nowUtc: args.nowUtc ?? new Date(),
    prospectId: args.prospectId,
    profileLabel: args.profileLabel,
  });

  const eventDetailBase = { by: args.callerEmail, via: "call_desk" as const };
  const events: OutreachEventInsert[] =
    args.prospectId == null
      ? []
      : (["deal_created", "handed_off"] as const).map((event) => ({
          prospect_id: args.prospectId as number,
          event,
          detail: { deal_id: null as number | null, ...eventDetailBase },
        }));

  const ready = isQuoteReady(args.payload);
  const jobs: QuoteJobInsert[] = ready
    ? JOB_KINDS.map((kind) => ({
        deal_id: null,
        status: "pending" as const,
        kind,
        requested_by: args.callerEmail,
      }))
    : [];

  return {
    dealInsert,
    events,
    jobs,
    quoteSkippedReason: ready ? null : QUOTE_SKIPPED_INCOMPLETE,
  };
}

/** Reject the whole insert if a stray column crept in — the TypeScript twin
 *  of db.py::validate_deal_update_fields. Returns an error, or null. */
export function guardInsert(insert: DealInsert): CreateDealFailure | null {
  const stray = disallowedInsertKeys(insert);
  if (stray.length === 0) return null;
  return {
    ok: false,
    status: 500,
    error: `Columns not in the deal-form allowlist: ${stray.join(", ")}`,
  };
}

/** The live path. Order matters: the deal must exist before anything points
 *  at it. Every step after the deal insert degrades to a warning — the caller
 *  must never be left unsure whether the deal exists. */
export async function writeDeal(
  supabase: SupabaseClient,
  plan: CreateDealPlan,
  ctx: { prospectId: number | null; callerEmail: string },
): Promise<CreateDealSuccess | CreateDealFailure> {
  const { data: deal, error: dealErr } = await supabase
    .from("deals")
    .insert(plan.dealInsert)
    .select("id")
    .single();
  if (dealErr || !deal) {
    const missingColumn =
      dealErr?.code === UNDEFINED_COLUMN ||
      /sf_lead_state|deals\.source/.test(dealErr?.message ?? "");
    return {
      ok: false,
      status: 500,
      error: missingColumn
        ? `${MIGRATION_023_MISSING} (${dealErr?.message})`
        : (dealErr?.message ?? "Deal insert returned no row"),
    };
  }

  const dealId = deal.id as number;
  const warnings: string[] = [];
  const detail = { deal_id: dealId, by: ctx.callerEmail, via: "call_desk" };

  if (ctx.prospectId != null) {
    const { error: createdErr } = await supabase
      .from("outreach_events")
      .insert({ prospect_id: ctx.prospectId, event: "deal_created", detail });
    if (createdErr)
      warnings.push(`deal_created event not logged: ${createdErr.message}`);

    const { error: prospectErr } = await supabase
      .from("outreach_prospects")
      .update({ status: "handed_off", updated_at: new Date().toISOString() })
      .eq("id", ctx.prospectId);
    if (prospectErr)
      warnings.push(`prospect not marked handed_off: ${prospectErr.message}`);

    const { error: handedErr } = await supabase
      .from("outreach_events")
      .insert({ prospect_id: ctx.prospectId, event: "handed_off", detail });
    if (handedErr)
      warnings.push(`handed_off event not logged: ${handedErr.message}`);
  }

  // retriage then quote, inserted one at a time so the worker sees them in
  // that order (it processes quote_jobs by id).
  const quoteJobIds: number[] = [];
  for (const job of plan.jobs) {
    const { data: row, error: jobErr } = await supabase
      .from("quote_jobs")
      .insert({ ...job, deal_id: dealId })
      .select("id")
      .single();
    if (jobErr || !row) {
      warnings.push(
        `${job.kind} job not queued: ${jobErr?.message ?? "no row returned"}`,
      );
      break;
    }
    quoteJobIds.push(row.id as number);
  }

  return {
    ok: true,
    dealId,
    quoteJobIds,
    quoteSkippedReason: plan.quoteSkippedReason,
    warnings,
  };
}
