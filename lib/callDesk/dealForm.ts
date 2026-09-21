// Guided "Generate deal" form — payload types, the column allowlist, and the
// pure functions that turn a form payload into the exact `deals` row to insert.
//
// The Python catering system owns `deals`. Everything here mirrors
// `Catering-Manager/v2/modules/db.py::create_deal` (lines ~816-905) and its
// allowlist / timestamp helpers (lines ~300-535). If the two ever disagree,
// db.py wins and this file gets fixed.
//
// Deliberately NO enumerations live in this file: event types and customer
// profiles come from `deal_form_options`, packages/extras from the pricing_*
// tables, flavors/toppings from `lib/menuOptions.ts` — all served at runtime by
// GET /api/call-desk/options.

import { serializeMultiselect } from "@/lib/menuOptions";
import {
  initialSfLeadState,
  isManualDealSource,
  manualSourceLabel,
  type ManualDealSource,
  type SfLeadState,
} from "@/lib/dealIntake";

// ---------------------------------------------------------------------------
// Column allowlist
// ---------------------------------------------------------------------------

// The exact `deals` columns this form is permitted to write. Every name here is
// a member of ALLOWED_DEAL_COLUMNS in
// Catering-Manager/v2/modules/db.py (the frozenset at db.py:~316-500) — checked
// name by name 2026-09-09. The route refuses any key outside this set plus
// DEAL_INSERT_INTERNAL_COLUMNS, the same defensive posture as
// db.py::validate_deal_update_fields.
export const DEAL_FORM_COLUMNS = [
  // 1. Contact
  "contact_first_name",
  "contact_last_name",
  "contact_email",
  "contact_phone",
  "company",
  // 8. Day-of contact
  "day_of_contact_name",
  "day_of_contact_phone",
  // 3. Event
  "event_date",
  "event_start_time",
  "event_end_time",
  "event_type",
  "event_name",
  "venue_name",
  "venue_address",
  "guest_count",
  "is_outdoor",
  // 4-7. Menu
  "package_name",
  "flavors",
  "toppings",
  "extras",
  "cart_service",
  // 8. Tail
  "tax_exempt",
  "lead_source",
  "how_did_you_hear",
  "notes",
] as const;

export type DealFormColumn = (typeof DEAL_FORM_COLUMNS)[number];

// Set by create_deal itself, never by the caller's payload. db.py calls these
// `internal_keys` and strips them before validate_deal_update_fields, because
// `is_active` is auto-maintained and `created_at` is in FORBIDDEN_DEAL_COLUMNS.
//
// `sf_lead_state` joins them from Catering-Manager migration 023. It is the
// one Salesforce column intake is allowed to set, and only ever to 'queued':
// "this deal did not come from the corporate form, so the mirror must make
// sure a Lead exists before it can convert one." Every later transition is the
// mirror's, through its own narrow writer (`sf_sync.write_sf_mirror`), which
// is why the other four sf_* columns are still absent from this list.
export const DEAL_INSERT_INTERNAL_COLUMNS = [
  "created_at",
  "updated_at",
  "stage",
  "payment_status",
  "is_active",
  "source",
  "sf_lead_state",
] as const;

const ALLOWED_INSERT_KEYS: ReadonlySet<string> = new Set<string>([
  ...DEAL_FORM_COLUMNS,
  ...DEAL_INSERT_INTERNAL_COLUMNS,
]);

// db.py::VALID_SOURCES — the call desk is always the phone channel. The
// manual "New deal" form picks its own from MANUAL_DEAL_SOURCES, so this is
// the default rather than the only possibility.
export const DEAL_SOURCE = "phone" as const;

/** How strictly to validate. The two intakes want different things:
 *
 *  `call_desk` — Joey is on the phone with the customer and can ask for
 *  anything, and the deal goes straight to the quote worker, which needs a
 *  package, a date and a guest count to price. So everything is required.
 *
 *  `manual` — somebody left a voicemail, or wrote two lines by email, or
 *  asked at the counter on their way out. Alina's rule for this form is a
 *  name plus one way to reach them plus where it came from; the rest is
 *  filled in as it is learned. A deal this thin gets no quote job (there is
 *  nothing to price), which is the one behavioural difference downstream.
 */
export type DealFormMode = "call_desk" | "manual";

// Pending a human ruling on what identifier belongs in lead_source (#409 says
// "stamped to the caller, identifier pending ruling; default the caller's
// email"). One constant so the ruling is a one-line change.
export function leadSourceFor(callerEmail: string): string {
  return callerEmail;
}

// The extra whose presence flips cart_service. Canonical label, matching
// pricing_extras.name and lib/menuOptions.ts EXTRAS.
export const CART_EXTRA_LABEL = "Ice Cream Cart";

// ---------------------------------------------------------------------------
// Payload + insert types
// ---------------------------------------------------------------------------

export type DealFormPayload = {
  // 1. Contact
  contact_first_name: string;
  contact_last_name: string;
  contact_email: string;
  contact_phone: string;
  company: string;
  // 2. Customer profile — reference only; there is no deals column for it yet
  // (#396 owns that), so it lands in notes. Value from deal_form_options.
  customer_profile: string;
  // 3. Event
  event_type: string;
  event_name: string;
  event_date: string; // YYYY-MM-DD
  event_start_time: string; // HH:MM (24h)
  event_end_time: string; // HH:MM (24h)
  venue_name: string;
  venue_address: string;
  guest_count: number | null;
  is_outdoor: boolean;
  // 4-7. Menu
  package_name: string;
  flavors: string[];
  toppings: string[];
  /** Flat list of repeated names — 3 × "Cookies" means quantity 3. Same
   *  storage shape MultiSelect(quantityMode) already writes from the deal
   *  drawer; the quote module accumulates per occurrence. */
  extras: string[];
  // 8. Tail
  tax_exempt: boolean;
  how_did_you_hear: string;
  day_of_contact_name: string;
  day_of_contact_phone: string;
  first_note: string;
  /** Intake channel. Empty on the call desk, where it is always 'phone';
   *  required on the manual form, where it is the third mandatory field. */
  source: ManualDealSource | "";
};

export type DealInsert = {
  created_at: string;
  updated_at: string;
  stage: "Open";
  payment_status: "None";
  is_active: 1;
  source: ManualDealSource;
  sf_lead_state: SfLeadState | null;
} & Partial<Record<DealFormColumn, string | number | null>>;

export type BuildDealInsertContext = {
  callerEmail: string;
  /** The instant the deal is being created. */
  nowUtc: Date;
  /** The call-desk prospect this deal was generated from, or null when a
   *  human typed it into the manual form with no prospect behind it. */
  prospectId: number | null;
  /** Human label of the picked customer profile, e.g. "Office admin". */
  profileLabel: string;
};

export const EMPTY_DEAL_FORM_PAYLOAD: DealFormPayload = {
  contact_first_name: "",
  contact_last_name: "",
  contact_email: "",
  contact_phone: "",
  company: "",
  customer_profile: "",
  event_type: "",
  event_name: "",
  event_date: "",
  event_start_time: "",
  event_end_time: "",
  venue_name: "",
  venue_address: "",
  guest_count: null,
  is_outdoor: false,
  package_name: "",
  flavors: [],
  toppings: [],
  extras: [],
  tax_exempt: false,
  how_did_you_hear: "",
  day_of_contact_name: "",
  day_of_contact_phone: "",
  first_note: "",
  source: "",
};

// ---------------------------------------------------------------------------
// Timestamp + text helpers
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** db.py::now_iso — UTC, no zone suffix, second precision. */
export function nowIso(now: Date): string {
  return (
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
  );
}

/** db.py::today_iso — YYYY-MM-DD anchored to America/New_York. Used for the
 *  `[YYYY-MM-DD]` notes prefix, the same convention the Python side writes. */
export function todayIsoEastern(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Trim; empty string becomes NULL so we never write "" into a text column. */
function textOrNull(value: string | null | undefined): string | null {
  const s = (value ?? "").trim();
  return s === "" ? null : s;
}

/** Tri-state / boolean columns are 0/1 integers (db.py::_coerce_booleans). */
function boolInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

// ---------------------------------------------------------------------------
// belowMinimum
// ---------------------------------------------------------------------------

/** The live hint shown under guest count: guests × package price vs the
 *  MINIMUM_ICE_CREAM scalar. Advisory only — the machine's triage enforces the
 *  real rule (which also counts extras and overrides). Returns false whenever
 *  any input is missing, so an incomplete form never shows a scary warning. */
export function belowMinimum(
  guests: number | null | undefined,
  packagePrice: number | null | undefined,
  minimum: number | null | undefined,
): boolean {
  if (!guests || guests <= 0) return false;
  if (!packagePrice || packagePrice <= 0) return false;
  if (!minimum || minimum <= 0) return false;
  return guests * packagePrice < minimum;
}

// ---------------------------------------------------------------------------
// shouldSuggestCakes
// ---------------------------------------------------------------------------

/** Parties this size or smaller are a cake sale, not a catering job.
 *  Two sheet cakes cover 50 people. Alina ruling 2026-09-09, bj-finance #411. */
export const CAKE_GUEST_MAX = 50;

/** How far a cake travels, one-way, from 218 S 40th St. Half of catering's
 *  70-minute one-way triage cap — an assumption Alina made on 2026-09-09
 *  (bj-finance #411), not a measurement. Beyond it, the customer picks up. */
export const CAKE_MAX_DRIVE_MINUTES = 35;

/** Where the customer actually orders. The CRM never places a cake order. */
export const CAKE_ORDER_URL = "https://www.benjerry.com/upenn/cakes";

/** Whether the call desk should point this party at cakes instead of catering.
 *  Guidance only — it never blocks a deal, because a small-but-rich party can
 *  still be worth catering. Returns false while guest count is unset. */
export function shouldSuggestCakes(guestCount: number | null): boolean {
  if (guestCount == null || !Number.isFinite(guestCount)) return false;
  if (guestCount <= 0) return false;
  return guestCount <= CAKE_GUEST_MAX;
}

// ---------------------------------------------------------------------------
// validateDealPayload
// ---------------------------------------------------------------------------

export type DealFormErrors = Partial<Record<keyof DealFormPayload, string>>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Deliberately loose: enough to catch a typo, not a deliverability check.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field-level errors for the guided form. Structural only — it does not know
 *  the enumerations (those are DB-sourced and validated by the CHECK
 *  constraints on insert). `limits.maxFlavors` is the MAX_FLAVORS scalar,
 *  passed in by the caller because it lives in pricing_scalars.
 *
 *  `limits.mode` picks the required set; it defaults to `call_desk`, so every
 *  existing caller keeps the behaviour it had. See `DealFormMode`.
 *
 *  Format checks apply in BOTH modes: a manual deal may leave the event date
 *  blank, but if somebody types one it still has to be a date. Nothing is
 *  loosened, only made optional. */
export function validateDealPayload(
  payload: DealFormPayload,
  limits?: { maxFlavors?: number; mode?: DealFormMode },
): DealFormErrors {
  const errors: DealFormErrors = {};
  const mode: DealFormMode = limits?.mode ?? "call_desk";
  const strict = mode === "call_desk";
  const req = (key: keyof DealFormPayload, message: string) => {
    if (!textOrNull(String(payload[key] ?? ""))) errors[key] = message;
  };

  req("contact_first_name", "First name is required");

  if (strict) {
    req("contact_email", "Email is required");
    req("contact_phone", "Phone is required");
    req("event_type", "Pick an event type");
    req("venue_address", "Venue address is required");
    req("package_name", "Pick a package");
  } else {
    // Minimal required set (Alina, the manual-intake spec): a name, ONE way
    // to reach them, and where the enquiry came from. Which contact method
    // is missing is not the point, so the message goes on both fields.
    const email = textOrNull(payload.contact_email);
    const phone = textOrNull(payload.contact_phone);
    if (!email && !phone) {
      const message = "Give an email or a phone number";
      errors.contact_email = message;
      errors.contact_phone = message;
    }
    if (!isManualDealSource(payload.source)) {
      errors.source = "Say where this enquiry came from";
    }
  }

  const email = textOrNull(payload.contact_email);
  if (email && !EMAIL_RE.test(email)) {
    errors.contact_email = "That does not look like an email address";
  }

  const date = textOrNull(payload.event_date);
  if (!date) {
    if (strict) errors.event_date = "Event date is required";
  } else if (!DATE_RE.test(date)) errors.event_date = "Use YYYY-MM-DD";

  const start = textOrNull(payload.event_start_time);
  if (!start) {
    if (strict) errors.event_start_time = "Start time is required";
  } else if (!TIME_RE.test(start)) errors.event_start_time = "Use HH:MM (24h)";

  const end = textOrNull(payload.event_end_time);
  if (!end) {
    if (strict) errors.event_end_time = "End time is required";
  } else if (!TIME_RE.test(end)) errors.event_end_time = "Use HH:MM (24h)";

  const guests = payload.guest_count;
  if (guests == null || Number.isNaN(guests)) {
    if (strict) errors.guest_count = "Guest count is required";
  } else if (!Number.isInteger(guests) || guests <= 0) {
    errors.guest_count = "Guest count must be a whole number above zero";
  }

  const maxFlavors = limits?.maxFlavors;
  if (maxFlavors && payload.flavors.length > maxFlavors) {
    errors.flavors = `At most ${maxFlavors} flavors`;
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Quote readiness
// ---------------------------------------------------------------------------

/** Whether a freshly created deal carries enough for the quote worker.
 *
 *  The worker re-triages (drive time, staff, labour) and then prices, and it
 *  cannot do either without a venue to drive to, a date to check staffing
 *  against, a head count and a package. Queueing a job for a deal that has
 *  none of those produces a failed job and a puzzled operator, so the manual
 *  intake queues nothing until the deal is complete — the deal sits in Open on
 *  the board like any other enquiry waiting on information.
 *
 *  A call-desk deal always satisfies this, because `validateDealPayload` in
 *  `call_desk` mode requires exactly these fields. That is deliberate: the two
 *  functions are the same rule stated for two purposes, and if the strict
 *  required set ever changes this is the function that has to change with it.
 */
export function isQuoteReady(payload: DealFormPayload): boolean {
  return Boolean(
    textOrNull(payload.venue_address) &&
      textOrNull(payload.event_date) &&
      textOrNull(payload.package_name) &&
      payload.guest_count != null &&
      Number.isInteger(payload.guest_count) &&
      (payload.guest_count ?? 0) > 0,
  );
}

export function hasErrors(errors: DealFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

/** The deal's opening notes block. Date-prefixed `[YYYY-MM-DD]` per the deals
 *  notes convention; the caller's own first note becomes a second prefixed
 *  line so it is never merged into the provenance line. */
export function buildNotes(
  payload: DealFormPayload,
  ctx: BuildDealInsertContext,
): string {
  const today = todayIsoEastern(ctx.nowUtc);
  const profile = textOrNull(ctx.profileLabel) ?? "not recorded";
  // Provenance is the whole point of this line: six months later, "why is
  // there no email thread on this deal?" is answered by "a human typed it in
  // after a walk-in", and attribution needs to survive in the row itself, not
  // only in an events table nobody opens.
  const origin =
    ctx.prospectId != null
      ? `Created from call desk by ${ctx.callerEmail} (prospect #${ctx.prospectId})`
      : `Created by hand by ${ctx.callerEmail} ` +
        `(source: ${manualSourceLabel(payload.source || DEAL_SOURCE)})`;
  const lines = [`[${today}] ${origin}. Profile: ${profile}.`];
  const first = textOrNull(payload.first_note);
  if (first) lines.push(`[${today}] ${first}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// buildDealInsert
// ---------------------------------------------------------------------------

/** Build the exact `deals` row for a call-desk deal.
 *
 *  Mirrors db.py::create_deal(source='phone'): stage 'Open', payment_status
 *  'None', is_active 1 (Open is not in TERMINAL_STAGES), created_at ==
 *  updated_at == now_iso(). List columns are JSON arrays of strings via
 *  serializeMultiselect (the CRM's existing writer). 0/1 integers for the
 *  boolean columns. Nothing outside DEAL_FORM_COLUMNS is ever emitted.
 */
export function buildDealInsert(
  payload: DealFormPayload,
  ctx: BuildDealInsertContext,
): DealInsert {
  const now = nowIso(ctx.nowUtc);
  const extras = payload.extras.filter((e) => e.trim() !== "");
  // An unrecognised source can only come from a tampered request body; the
  // route validates first, so falling back to 'phone' here is belt-and-braces
  // rather than a real branch. It must never fall back to 'form'.
  const source: ManualDealSource = isManualDealSource(payload.source)
    ? payload.source
    : DEAL_SOURCE;

  const insert: DealInsert = {
    // create_deal internals
    created_at: now,
    updated_at: now,
    stage: "Open",
    payment_status: "None",
    is_active: 1, // 'Open' is not in TERMINAL_STAGES
    source,
    // Non-form deal, so no corporate Lead exists: ask the mirror to make one.
    sf_lead_state: initialSfLeadState(source),

    // 1. Contact
    contact_first_name: textOrNull(payload.contact_first_name),
    contact_last_name: textOrNull(payload.contact_last_name),
    contact_email: textOrNull(payload.contact_email),
    contact_phone: textOrNull(payload.contact_phone),
    company: textOrNull(payload.company),

    // 3. Event
    event_type: textOrNull(payload.event_type),
    event_name: textOrNull(payload.event_name),
    event_date: textOrNull(payload.event_date),
    event_start_time: textOrNull(payload.event_start_time),
    event_end_time: textOrNull(payload.event_end_time),
    venue_name: textOrNull(payload.venue_name),
    venue_address: textOrNull(payload.venue_address),
    guest_count:
      payload.guest_count != null && Number.isFinite(payload.guest_count)
        ? Math.trunc(payload.guest_count)
        : null,
    is_outdoor: boolInt(payload.is_outdoor), // never NULL; 0 default

    // 4-7. Menu
    package_name: textOrNull(payload.package_name),
    flavors: serializeMultiselect(payload.flavors),
    toppings: serializeMultiselect(payload.toppings),
    extras: serializeMultiselect(extras),
    cart_service: extras.includes(CART_EXTRA_LABEL) ? 1 : 0,

    // 8. Tail
    tax_exempt: boolInt(payload.tax_exempt),
    how_did_you_hear: textOrNull(payload.how_did_you_hear),
    day_of_contact_name: textOrNull(payload.day_of_contact_name),
    day_of_contact_phone: textOrNull(payload.day_of_contact_phone),
    lead_source: leadSourceFor(ctx.callerEmail),
    notes: buildNotes(payload, ctx),
  };

  return insert;
}

/** Defensive guard, the TypeScript twin of db.py::validate_deal_update_fields:
 *  reject the WHOLE insert if any key falls outside the allowlist. Returns the
 *  offending keys (empty array = clean). */
export function disallowedInsertKeys(insert: Record<string, unknown>): string[] {
  return Object.keys(insert).filter((k) => !ALLOWED_INSERT_KEYS.has(k));
}
