// Certificate of Insurance (COI) — the pure half.
//
// bj-finance #343 (CH-10), from the #333 ruling "COI: REVIVE + BUILD — a COI
// widget in the CRM so the human stops filling the Hartford form manually".
//
// Nothing here touches Supabase or React. Given a deal row it answers two
// questions a human otherwise answers by hand every time a venue demands proof
// of insurance:
//
//   1. Where does this deal stand on its COI?  -> coiStatus()
//   2. What exactly do I type into The Hartford's certificate request?
//      -> buildCoiRequest()
//
// The status logic is the CRM-side twin of the production conformance check
// `revive.coi_required_unsent` in Catering-Manager health/conformance.sql:
//   coi_required = 1 AND coi_sent_at IS NULL AND event_date in [today, +14d].
// Keeping the 14-day window identical here means the badge the human sees in
// the drawer and the red row the instrument raises in prod are the same fact.
//
// The DB columns this reads (Catering-Manager migrations/pg_schema.sql):
//   coi_required INTEGER (0/1, nullable) — the requirement gate
//   coi_sent_at  TEXT (ISO timestamp, nullable) — NULL until the COI is sent
//   venue_name / venue_address / billing_* — the certificate holder
//   event_* / guest_count — the description of operations

import type { Deal } from "@/lib/types";

/** How close an event has to be for an unsent-COI to count as urgent. Kept
 *  identical to the prod conformance window so the CRM and the instrument
 *  agree on what "at risk" means. */
export const COI_URGENT_WINDOW_DAYS = 14;

/** The Named Insured on the policy. Its name appears inside the description of
 *  operations and the whole-request block for the certificate holder's
 *  reference, but its mailing address is deliberately omitted: The Hartford's
 *  Business Service Center fills the insured and its address into the ACORD
 *  "insured" box automatically from the policy, so a requester never retypes
 *  them. The panel also shows this as standalone context under the field pack. */
export const NAMED_INSURED = {
  legalName: "Withers Ventures LLC",
  dba: "Ben & Jerry's — University City",
  note:
    "On the Hartford policy. The Business Service Center auto-fills the " +
    "insured and its address; you do not retype them.",
} as const;

export type CoiStatus =
  | "not_required" // coi_required is not set
  | "sent" // coi_sent_at is stamped
  | "needed" // required, unsent, event not inside the urgent window
  | "needed_urgent"; // required, unsent, event within COI_URGENT_WINDOW_DAYS

/** Parse a stored "YYYY-MM-DD" event_date into whole days from `today`
 *  (also "YYYY-MM-DD"). Both are treated as calendar dates in the same zone —
 *  the stored value is already Eastern-local — so this is pure date
 *  arithmetic with no timezone shift. Returns null when either is unparseable. */
export function daysUntil(
  eventDate: string | null | undefined,
  today: string,
): number | null {
  const ev = parseYmd(eventDate);
  const now = parseYmd(today);
  if (ev === null || now === null) return null;
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((ev - now) / MS);
}

function parseYmd(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  return Number.isNaN(t) ? null : t;
}

/** Today as "YYYY-MM-DD" in America/New_York — the same zone every date in
 *  the catering DB is stored in. */
export function easternToday(now: Date = new Date()): string {
  // en-CA gives ISO-shaped YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Where this deal stands on its COI. `today` defaults to Eastern today. */
export function coiStatus(deal: Deal, today: string = easternToday()): CoiStatus {
  if (deal.coi_required !== 1) return "not_required";
  if (deal.coi_sent_at && deal.coi_sent_at.trim() !== "") return "sent";
  const d = daysUntil(deal.event_date, today);
  if (d !== null && d >= 0 && d <= COI_URGENT_WINDOW_DAYS) return "needed_urgent";
  return "needed";
}

export type CoiRequest = {
  /** The party requiring proof of insurance — the venue. */
  certificateHolderName: string | null;
  certificateHolderAddress: string | null;
  /** The venue is normally added as additional insured for the event. */
  additionalInsured: string | null;
  /** Free-text ACORD "Description of Operations / Locations" line. */
  descriptionOfOperations: string;
  /** Deal-derived event facts, already formatted for reading. */
  eventLabel: string;
  eventDateText: string | null;
  eventTimeText: string | null;
  guestCount: number | null;
  /** Fields a COI request cannot go out without that this deal is missing. */
  missing: string[];
  /** The whole request as one labeled block, for a single copy action. */
  fullText: string;
};

/** Assemble the fields a Hartford certificate request needs from a deal. Pure:
 *  same deal in, same request out. */
export function buildCoiRequest(deal: Deal): CoiRequest {
  const holderName = firstNonEmpty(deal.venue_name, deal.company);
  const holderAddress = firstNonEmpty(
    deal.venue_address,
    composeBillingAddress(deal),
  );
  const eventLabel =
    firstNonEmpty(deal.event_name, deal.event_type) ?? "Ice cream catering";
  const eventDateText = formatEventDate(deal.event_date);
  const eventTimeText = formatTimeRange(
    deal.event_start_time,
    deal.event_end_time,
  );
  const guestCount = typeof deal.guest_count === "number" ? deal.guest_count : null;

  const descriptionOfOperations = composeDescription({
    eventLabel,
    eventDateText,
    eventTimeText,
    guestCount,
    holderName,
    holderAddress,
  });

  const missing: string[] = [];
  if (!holderName) missing.push("certificate holder (venue name)");
  if (!holderAddress) missing.push("certificate holder address");
  if (!eventDateText) missing.push("event date");

  const fullText = composeFullText({
    holderName,
    holderAddress,
    descriptionOfOperations,
    additionalInsured: holderName,
  });

  return {
    certificateHolderName: holderName,
    certificateHolderAddress: holderAddress,
    additionalInsured: holderName,
    descriptionOfOperations,
    eventLabel,
    eventDateText,
    eventTimeText,
    guestCount,
    missing,
    fullText,
  };
}

function composeDescription(p: {
  eventLabel: string;
  eventDateText: string | null;
  eventTimeText: string | null;
  guestCount: number | null;
  holderName: string | null;
  holderAddress: string | null;
}): string {
  const parts: string[] = [];
  parts.push(
    `Ice cream catering service provided by ${NAMED_INSURED.legalName} ` +
      `(dba ${NAMED_INSURED.dba})`,
  );
  parts.push(`for ${p.eventLabel}`);
  if (p.eventDateText) {
    parts.push(`on ${p.eventDateText}${p.eventTimeText ? `, ${p.eventTimeText}` : ""}`);
  }
  if (p.guestCount) parts.push(`for approximately ${p.guestCount} guests`);
  const where = [p.holderName, p.holderAddress].filter(Boolean).join(", ");
  if (where) parts.push(`at ${where}`);
  let sentence = parts.join(" ") + ".";
  if (p.holderName) {
    sentence +=
      ` ${p.holderName} is included as an additional insured with respect ` +
      `to this event.`;
  }
  return sentence;
}

function composeFullText(p: {
  holderName: string | null;
  holderAddress: string | null;
  descriptionOfOperations: string;
  additionalInsured: string | null;
}): string {
  const lines: string[] = [];
  lines.push("CERTIFICATE HOLDER");
  lines.push(p.holderName ?? "(venue name missing — fill on the deal)");
  lines.push(p.holderAddress ?? "(venue address missing — fill on the deal)");
  lines.push("");
  lines.push("DESCRIPTION OF OPERATIONS / EVENT");
  lines.push(p.descriptionOfOperations);
  lines.push("");
  lines.push("ADDITIONAL INSURED");
  lines.push(
    p.additionalInsured
      ? `${p.additionalInsured} — add as additional insured for this event`
      : "(add the venue as additional insured)",
  );
  lines.push("");
  lines.push("NAMED INSURED (on policy — the portal auto-fills this)");
  lines.push(`${NAMED_INSURED.legalName} (dba ${NAMED_INSURED.dba})`);
  return lines.join("\n");
}

function composeBillingAddress(deal: Deal): string | null {
  const street = deal.billing_street?.trim();
  const city = deal.billing_city?.trim();
  const state = deal.billing_state?.trim();
  const zip = deal.billing_zip?.trim();
  const cityState = [city, state].filter(Boolean).join(", ");
  const tail = [cityState, zip].filter(Boolean).join(" ");
  const full = [street, tail].filter(Boolean).join(", ");
  return full || null;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09-25" -> "September 25, 2026", no timezone shift. */
export function formatEventDate(s: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((s ?? "").trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const mi = Number(mo) - 1;
  if (mi < 0 || mi > 11) return null;
  return `${MONTHS[mi]} ${Number(d)}, ${y}`;
}

/** "14:30" -> "2:30 PM"; builds a range when both ends are present. */
export function formatTimeRange(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  const s = formatTime(start);
  const e = formatTime(end);
  if (s && e) return `${s}–${e}`;
  return s ?? e ?? null;
}

function formatTime(s: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((s ?? "").trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2];
  if (h < 0 || h > 23) return null;
  const ampm = h < 12 ? "AM" : "PM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}

function firstNonEmpty(...vals: (string | null | undefined)[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}
