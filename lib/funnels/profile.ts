// Customer-profile derivation for the Funnels tab (bj-finance #422).
//
// The spec (issue #422, layer 1 item 2) asks for a customer profile DERIVED
// from a deal's free-text event_type plus its email domain. It says "in a SQL
// view for now" — we do the same derivation in TypeScript instead, on purpose:
// a view is DDL, and this layer-1 pass is pure reads that must run today
// without an Alex-approved migration. The rule set here is the single source
// of truth; the proposed layer-2 migration (supabase/crm/007_*) backfills
// deals.profile from EXACTLY this logic so the column and the tab never drift.
//
// event_type is dirty (nulls, synonyms, casing, stray punctuation), so every
// comparison is done on a normalized, lower-cased, whitespace-collapsed form.
// Keep this file free of I/O so it stays unit-testable and cheap to reason
// about — the reviewer has to trust it without running the app.

export const PROFILES = [
  "wedding",
  "mitzvah",
  "office_admin",
  "penn_account",
  "family_celebration",
  "unclassified",
] as const;

export type Profile = (typeof PROFILES)[number];

/** Human labels for the UI — the machine value stays snake_case. */
export const PROFILE_LABELS: Record<Profile, string> = {
  wedding: "Wedding",
  mitzvah: "Mitzvah",
  office_admin: "Office / admin",
  penn_account: "Penn account",
  family_celebration: "Family celebration",
  unclassified: "Unclassified",
};

/** Lower-case, trim, collapse internal whitespace. `null`/blank -> "". */
export function normalizeEventType(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The domain part of an email, lower-cased. "" when there is no usable one. */
export function emailDomain(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1).toLowerCase().trim();
}

// Free consumer webmail — a business email domain is one that is NOT one of
// these. Kept small and explicit; the corporate signal only has to separate
// "someone's personal address" from "someone writing from an organisation".
const CONSUMER_DOMAINS = new Set<string>([
  "gmail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "protonmail.com",
  "proton.me",
]);

export function isPennDomain(domain: string): boolean {
  // upenn.edu and its sub-domains (wharton.upenn.edu, seas.upenn.edu, ...).
  return domain === "upenn.edu" || domain.endsWith(".upenn.edu");
}

export function isBusinessDomain(domain: string): boolean {
  if (!domain) return false;
  if (CONSUMER_DOMAINS.has(domain)) return false;
  // A bare token with no dot is not a real domain.
  return domain.includes(".");
}

// event_type -> profile intent, before the email-domain tie-breaks. Substring
// matching against the normalized event_type, checked in priority order.
const WEDDING_MARKERS = ["wedding", "bridal", "rehearsal", "engagement"];
const MITZVAH_MARKERS = ["mitzvah"]; // "bar or bat mitzvah", "bar mitzvah", ...
const FAMILY_MARKERS = [
  "birthday",
  "baby shower",
  "gender reveal",
  "family reunion",
];
// Corporate / workplace event types. These only become office_admin when the
// email domain is a business one (item 2: "corporate event types + business
// email domain"); otherwise they fall through to unclassified.
const CORPORATE_MARKERS = [
  "corporate",
  "employee appreciation",
  "appreciation - employee",
  "employee",
  "office",
  "staff",
  "company",
  "team",
  "work",
  "conference",
  "meeting",
  "business",
  "client",
  "holiday party",
];

function matchesAny(haystack: string, markers: string[]): boolean {
  return markers.some((m) => haystack.includes(m));
}

/**
 * Derive the customer profile for a deal.
 *
 * Precedence (first match wins), matching issue #422 item 2:
 *   1. penn_account       — an @upenn.edu (or sub-domain) contact, whatever the event
 *   2. wedding            — wedding / bridal / rehearsal / engagement event types
 *   3. mitzvah            — bar or bat mitzvah
 *   4. office_admin       — a corporate event type AND a business email domain
 *   5. family_celebration — birthday / baby shower / gender reveal / family reunion
 *   6. unclassified       — everything else (incl. corporate-from-a-gmail)
 *
 * penn_account is checked first deliberately: a Penn buyer is a Penn account
 * regardless of what they are celebrating — it is the relationship, not the
 * party, that the profile is naming for the scoreboard.
 */
export function deriveProfile(
  eventType: string | null | undefined,
  email: string | null | undefined,
): Profile {
  const et = normalizeEventType(eventType);
  const domain = emailDomain(email);

  if (isPennDomain(domain)) return "penn_account";
  if (matchesAny(et, WEDDING_MARKERS)) return "wedding";
  if (matchesAny(et, MITZVAH_MARKERS)) return "mitzvah";
  if (matchesAny(et, CORPORATE_MARKERS) && isBusinessDomain(domain)) {
    return "office_admin";
  }
  if (matchesAny(et, FAMILY_MARKERS)) return "family_celebration";
  return "unclassified";
}
