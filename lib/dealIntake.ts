// Manual deal intake — the vocabulary shared by the "New deal" form, the call
// desk's "Generate deal" form, and the API routes behind both.
//
// Why this file exists: until now the only way a deal entered the CRM was the
// corporate catering form on benjerry.com/upenn/catering (source 'form') or
// the call desk, which hard-coded source 'phone' and could only work a
// prospect already sitting in the call queue. A customer who emails, walks in,
// or rings a number nobody logged had no way in at all.
//
// The Python catering system owns `deals`. The source vocabulary here is the
// TypeScript twin of `Catering-Manager/v2/modules/db.py::VALID_SOURCES` and of
// the CHECK constraint on `deals.source`. All three must agree; db.py wins and
// this file gets fixed.

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** The channels a human can pick when entering a deal by hand.
 *
 *  'form' is deliberately absent: only the corporate catering form's own
 *  intake may claim it, because 'form' is what tells the Salesforce mirror
 *  that a corporate Lead already exists for this enquiry. Letting a human
 *  stamp 'form' on a walk-in would make the mirror search Salesforce forever
 *  for a Lead that was never created.
 *
 *  'migrated' is absent for the same reason in reverse: it belongs to the 9.5k
 *  historic rows imported from Salesforce and nothing new may join them.
 */
export const MANUAL_DEAL_SOURCES = [
  {
    value: "phone",
    label: "Phone call",
    hint: "They rang us",
  },
  {
    value: "email",
    label: "Email",
    hint: "They wrote to catering@ or replied to outreach",
  },
  {
    value: "walk_in",
    label: "Walk-in",
    hint: "They asked at the counter",
  },
  {
    value: "other",
    label: "Other",
    hint: "Referral, event, social DM — say which in the note",
  },
] as const;

export type ManualDealSource = (typeof MANUAL_DEAL_SOURCES)[number]["value"];

const MANUAL_SOURCE_VALUES: ReadonlySet<string> = new Set(
  MANUAL_DEAL_SOURCES.map((s) => s.value),
);

export function isManualDealSource(value: unknown): value is ManualDealSource {
  return typeof value === "string" && MANUAL_SOURCE_VALUES.has(value);
}

export function manualSourceLabel(value: string): string {
  return MANUAL_DEAL_SOURCES.find((s) => s.value === value)?.label ?? value;
}

// ---------------------------------------------------------------------------
// Salesforce lead-creation queue
// ---------------------------------------------------------------------------

// `deals.sf_lead_state` (Catering-Manager migration 023). It is the queue the
// nightly Salesforce mirror reads to decide whether a deal is allowed to have
// a corporate Lead CREATED for it, as opposed to merely matched.
//
// The distinction matters because of a rule recorded in the mirror's own
// source: "Form-sourced deals ALWAYS get a Lead search first. The corporate
// catering form auto-creates Leads in SF. Creating without searching would
// duplicate records in the franchisor's system." A manually entered deal has
// no Lead by construction, so it is the one case where creating is correct —
// and even then the mirror searches first and only creates on a miss.
export const SF_LEAD_STATE = {
  /** Intake has asked the mirror to make sure a Lead exists. */
  QUEUED: "queued",
  /** The mirror is mid-create (set before the irreversible step). */
  CREATING: "creating",
  /** A Lead now exists — either found by search or created by the mirror. */
  CREATED: "created",
  /** The mirror tried and could not; `sf_mirror_error` says why. */
  FAILED: "failed",
  /** Deliberately out of scope (internal test enquiry, legacy row). */
  SKIPPED: "skipped",
} as const;

export type SfLeadState = (typeof SF_LEAD_STATE)[keyof typeof SF_LEAD_STATE];

/** The state a freshly, manually created deal starts in.
 *
 *  Every manual source needs one: none of them produced a corporate Lead.
 *  Returns null for anything that did (i.e. 'form'), so the column stays NULL
 *  and the mirror behaves exactly as it does today for form enquiries.
 */
export function initialSfLeadState(source: string): SfLeadState | null {
  return isManualDealSource(source) ? SF_LEAD_STATE.QUEUED : null;
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/** Digits-only phone key. Mirrors `public.normalize_phone()` in
 *  supabase/crm/003_call_desk_compliance.sql and `normalizePhone` in
 *  lib/callDesk/compliance.ts — all three must agree or a duplicate stops
 *  matching itself. Kept here rather than imported so this module stays free
 *  of the compliance module's calendar machinery. */
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export function emailKey(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  return s === "" ? null : s;
}

/** One existing record that looks like the one being typed. */
export type DedupeMatch = {
  kind: "deal" | "prospect";
  id: number;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  /** Deals only: stage and event date, so the caller can see at a glance
   *  whether this is the same enquiry or last year's party. */
  stage?: string | null;
  event_date?: string | null;
  /** Which key matched. Both is the strongest signal. */
  matched: ("email" | "phone")[];
};

export type DedupeResponse = {
  matches: DedupeMatch[];
  /** True when the caller supplied nothing worth looking up. */
  skipped: boolean;
};

/** A duplicate warning is advisory, never a block: the same office books us
 *  four times a year from the same address, and the second booking is a new
 *  deal, not a mistake. The UI says what it found and lets the human decide. */
export const DEDUPE_IS_ADVISORY =
  "This is a warning, not a block. Repeat customers are normal — " +
  "open the match if you meant to update it, or carry on to create a new deal.";
