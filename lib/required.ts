// Hard-required fields per stage, mirroring catering automation's
// modules/validators.py `HARD_REQUIRED_BY_STAGE`. A deal at stage X
// must have every field whose required-from <= X.
//
// Keep this in lockstep with the Python validator. If a field gets
// added or moved there, mirror it here.

import type { Deal } from "@/lib/types";
import type { Stage } from "@/lib/stages";

// Cumulative stage order. Deal at stage[i] is required to have every
// field listed at stage <= i.
const STAGE_ORDER: Stage[] = [
  "Open",
  "Quote Review",
  "Sent Quote",
  "Booked Unpaid",
  "Booked Paid",
  "Event Complete",
];

function stageIndex(stage: string | null | undefined): number {
  if (!stage) return -1;
  return STAGE_ORDER.indexOf(stage as Stage);
}

// Field -> stage at which it becomes required.
// Mirrors HARD_REQUIRED_BY_STAGE in validators.py. System-only fields
// (gmail_thread_id, created_at, quote_pdf_path, quote_docx_path,
// last_outbound_at) are intentionally OMITTED here — they're set
// by the catering pipeline, not by Alina, and surfacing them as
// "missing" in the UI would just be noise she can't act on.
//
// Flavors and toppings are CUSTOMER_SUPPLIED_OPTIONAL in validators.py
// but operationally required to build a picklist. Adding them here so
// the "!" badge fires once the deal is booked. Toppings are gated
// further by `isMissing` below (Cup or Cone / Waffle Cone packages
// have zero toppings so missing toppings on them is not a gap).
const HARD_REQUIRED: Partial<Record<keyof Deal, Stage>> = {
  // Open
  contact_first_name: "Open",
  contact_email: "Open",
  // Quote Review
  event_date: "Quote Review",
  event_start_time: "Quote Review",
  event_end_time: "Quote Review",
  venue_address: "Quote Review",
  guest_count: "Quote Review",
  package_name: "Quote Review",
  // mileage_charge_eligible defaults to "we drove" (=1) when unset, so
  // it's never actually missing. Removed from the required list per
  // Alina 2026-06-11.
  // round_trip_miles is required when we're billing per-mile (Uber
  // unchecked). isMissing() below suppresses it when Uber is checked
  // (mileage_charge_eligible === 0) — Uber events bill the flat fee
  // and miles aren't part of the quote math.
  round_trip_miles: "Quote Review",
  subtotal_pretax: "Quote Review",
  total_with_tax: "Quote Review",
  // Booked Unpaid
  signed_contract_total: "Booked Unpaid",
  flavors: "Booked Unpaid",
  toppings: "Booked Unpaid",
  // Booked Paid: amount_paid > 0
  amount_paid: "Booked Paid",
};

// Packages that DON'T include toppings. Mirrors dry_toppings_count = 0
// in pricing_packages. Used to skip the toppings-missing badge on
// those packages (otherwise every Cup or Cone deal would scream).
const PACKAGES_WITHOUT_TOPPINGS: ReadonlySet<string> = new Set([
  "Cup or Cone Party",
  "Waffle Cone Party",
  "DIY Ice Cream Social",
]);

// Human-readable labels for the missing-field display.
const FIELD_LABELS: Partial<Record<keyof Deal, string>> = {
  contact_first_name: "Contact first name",
  contact_email: "Contact email",
  event_date: "Event date",
  event_start_time: "Start time",
  event_end_time: "End time",
  venue_address: "Venue address",
  guest_count: "Guest count",
  package_name: "Package",
  subtotal_pretax: "Subtotal (pretax)",
  total_with_tax: "Total with tax",
  round_trip_miles: "Round-trip miles",
  signed_contract_total: "Signed contract total",
  amount_paid: "Amount paid",
  flavors: "Flavours",
  toppings: "Toppings",
};

// Parse a stored flavors/toppings field. Accepts JSON arrays, doubly-
// encoded strings, and comma-separated. Returns a flat list of trimmed
// non-empty entries, or [] if nothing usable.
function parseListField(v: unknown): string[] {
  if (Array.isArray(v))
    return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v !== "string") return [];
  const s = v.trim();
  if (!s || s === "[]" || s === '"[]"' || s === '"[]"') return [];
  // Try JSON parse first.
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      // Could be doubly-encoded: ["[]"] or ["a","b"]
      return parsed
        .flatMap((x) => {
          if (typeof x === "string" && x.startsWith("[")) {
            try {
              const inner = JSON.parse(x);
              return Array.isArray(inner) ? inner : [x];
            } catch {
              return [x];
            }
          }
          return [x];
        })
        .map((x) => String(x).trim())
        .filter(Boolean);
    }
  } catch {
    // Fall through to CSV split.
  }
  return s
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function isMissing(deal: Deal, field: keyof Deal): boolean {
  const v = (deal as Record<string, unknown>)[field];
  // round_trip_miles is only required when we're billing mileage.
  // Uber events bill the flat fee — miles aren't needed. Suppress
  // the check when the Uber checkbox is on (mileage_charge_eligible
  // === 0). Null mce defaults to "we drove" → miles still required.
  if (field === "round_trip_miles" && deal.mileage_charge_eligible === 0) {
    return false;
  }
  if (v === null || v === undefined) return true;
  // amount_paid > 0 specifically; zero or negative count as missing.
  if (field === "amount_paid") {
    return typeof v === "number" ? v <= 0 : true;
  }
  // flavors: missing iff parsed list is empty.
  if (field === "flavors") {
    return parseListField(v).length === 0;
  }
  // toppings: missing iff parsed list is empty AND the package
  // actually includes toppings. Cup or Cone / Waffle Cone / DIY all
  // have dry_toppings_count = 0 and don't trigger.
  if (field === "toppings") {
    const pkg = (deal.package_name ?? "").trim();
    if (PACKAGES_WITHOUT_TOPPINGS.has(pkg)) return false;
    return parseListField(v).length === 0;
  }
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

// Returns the list of required fields that are missing on this deal at
// its current stage. User-facing fields only (labels live in
// FIELD_LABELS). Empty array when nothing is missing.
export function missingRequiredFields(deal: Deal): {
  field: keyof Deal;
  label: string;
}[] {
  const idx = stageIndex(deal.stage);
  if (idx < 0) return [];
  const out: { field: keyof Deal; label: string }[] = [];
  for (const [field, requiredFrom] of Object.entries(HARD_REQUIRED) as [
    keyof Deal,
    Stage,
  ][]) {
    if (stageIndex(requiredFrom) > idx) continue;
    if (!isMissing(deal, field)) continue;
    out.push({ field, label: FIELD_LABELS[field] ?? String(field) });
  }
  return out;
}

export function hasMissingRequired(deal: Deal): boolean {
  return missingRequiredFields(deal).length > 0;
}
