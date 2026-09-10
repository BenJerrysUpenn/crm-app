import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildDealInsert,
  disallowedInsertKeys,
  hasErrors,
  validateDealPayload,
  type DealFormPayload,
  type DealInsert,
} from "@/lib/callDesk/dealForm";

export const dynamic = "force-dynamic";

// Write gate. The human has not ruled on the write mechanism yet (#409), and
// the prototype standard is dry-run all the way to the prod boundary, so the
// route computes every row and returns them without writing unless this env
// var is explicitly "live".
const WRITE_MODE_ENV = "CALL_DESK_DEAL_WRITES";
function writesAreLive(): boolean {
  return process.env[WRITE_MODE_ENV] === "live";
}

// The worker must re-triage (drive time, staff, labor) before it can price, so
// the jobs go in this order; the Mac-side worker processes quote_jobs by id.
const JOB_KINDS = ["retriage", "quote"] as const;

type QuoteJobInsert = {
  deal_id: number | null;
  status: "pending";
  kind: (typeof JOB_KINDS)[number];
  requested_by: string;
};

type OutreachEventInsert = {
  prospect_id: number;
  event: "deal_created" | "handed_off";
  detail: Record<string, unknown>;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter((s) => s.trim() !== "") : [];
}

function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

function int(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Coerce an untrusted JSON body into the payload shape. Unknown keys are
 *  dropped here, before anything reaches buildDealInsert. */
function readPayload(body: Record<string, unknown>): DealFormPayload {
  return {
    contact_first_name: str(body.contact_first_name),
    contact_last_name: str(body.contact_last_name),
    contact_email: str(body.contact_email),
    contact_phone: str(body.contact_phone),
    company: str(body.company),
    customer_profile: str(body.customer_profile),
    event_type: str(body.event_type),
    event_name: str(body.event_name),
    event_date: str(body.event_date),
    event_start_time: str(body.event_start_time),
    event_end_time: str(body.event_end_time),
    venue_name: str(body.venue_name),
    venue_address: str(body.venue_address),
    guest_count: int(body.guest_count),
    is_outdoor: bool(body.is_outdoor),
    package_name: str(body.package_name),
    flavors: strList(body.flavors),
    toppings: strList(body.toppings),
    extras: strList(body.extras),
    tax_exempt: bool(body.tax_exempt),
    how_did_you_hear: str(body.how_did_you_hear),
    day_of_contact_name: str(body.day_of_contact_name),
    day_of_contact_phone: str(body.day_of_contact_phone),
    first_note: str(body.first_note),
  };
}

/** Human label for the picked customer profile. Read from deal_form_options so
 *  the notes line says "Office admin", not "office_admin"; falls back to the
 *  client's label, then the raw value, so a missing migration cannot block a
 *  dry run. */
async function profileLabelFor(
  supabase: ReturnType<typeof createClient>,
  value: string,
  clientLabel: string,
): Promise<string> {
  if (!value) return "";
  const { data } = await supabase
    .from("deal_form_options")
    .select("label")
    .eq("field", "customer_profile")
    .eq("value", value)
    .maybeSingle();
  return data?.label ?? (clientLabel || value);
}

// POST /api/call-desk/deals
//
// Body: the guided-form payload + `prospect_id` (+ `customer_profile`, which is
// part of the payload). Creates the deal on the canonical write path —
// Catering-Manager/v2/modules/db.py::create_deal(source='phone') — then records
// the hand-off on the prospect and enqueues the worker jobs.
//
// Default response is a DRY RUN: the exact rows that would be written, nothing
// touched. Set CALL_DESK_DEAL_WRITES=live to actually write.
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

  const payload = readPayload(body);
  const maxFlavors = int(body.max_flavors) ?? undefined;
  const errors = validateDealPayload(payload, { maxFlavors });
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

  const dealInsert = buildDealInsert(payload, {
    callerEmail,
    nowUtc: new Date(),
    prospectId,
    profileLabel,
  });

  // Defensive allowlist guard, mirroring db.py::validate_deal_update_fields:
  // reject the whole request rather than silently dropping a stray column.
  const stray = disallowedInsertKeys(dealInsert);
  if (stray.length > 0)
    return NextResponse.json(
      { error: `Columns not in the deal-form allowlist: ${stray.join(", ")}` },
      { status: 500 },
    );

  const eventDetailBase = { by: callerEmail, via: "call_desk" as const };
  const plannedEvents: OutreachEventInsert[] = [
    {
      prospect_id: prospectId,
      event: "deal_created",
      detail: { deal_id: null as number | null, ...eventDetailBase },
    },
    {
      prospect_id: prospectId,
      event: "handed_off",
      detail: { deal_id: null as number | null, ...eventDetailBase },
    },
  ];
  const plannedJobs: QuoteJobInsert[] = JOB_KINDS.map((kind) => ({
    deal_id: null,
    status: "pending",
    kind,
    requested_by: callerEmail,
  }));

  if (!writesAreLive()) {
    return NextResponse.json({
      dry_run: true,
      reason: `${WRITE_MODE_ENV} is not "live" — nothing was written`,
      deal_insert: dealInsert,
      events: plannedEvents,
      prospect_update: {
        table: "outreach_prospects",
        id: prospectId,
        status: "handed_off",
        updated_at: "now()",
      },
      quote_jobs: plannedJobs,
    });
  }

  return await writeLive(supabase, dealInsert, {
    prospectId,
    callerEmail,
    plannedJobs,
  });
}

/** The live path. Order matters: the deal must exist before anything points at
 *  it. Every step after the deal insert degrades to a warning — the caller must
 *  never be left unsure whether the deal exists. */
async function writeLive(
  supabase: ReturnType<typeof createClient>,
  dealInsert: DealInsert,
  ctx: {
    prospectId: number;
    callerEmail: string;
    plannedJobs: QuoteJobInsert[];
  },
) {
  const { data: deal, error: dealErr } = await supabase
    .from("deals")
    .insert(dealInsert)
    .select("id")
    .single();
  if (dealErr || !deal)
    return NextResponse.json(
      { error: dealErr?.message ?? "Deal insert returned no row" },
      { status: 500 },
    );

  const dealId = deal.id as number;
  const warnings: string[] = [];
  const detail = { deal_id: dealId, by: ctx.callerEmail, via: "call_desk" };

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

  // retriage then quote, inserted one at a time so the worker sees them in
  // that order (it processes quote_jobs by id).
  const quoteJobIds: number[] = [];
  for (const job of ctx.plannedJobs) {
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

  return NextResponse.json({
    deal_id: dealId,
    quote_job_ids: quoteJobIds,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}
