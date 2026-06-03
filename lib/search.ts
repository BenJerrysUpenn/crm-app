import type { Deal } from "@/lib/types";

// Lower-case haystack of every field a user might search on.
function searchHaystack(deal: Deal): string {
  return [
    deal.id,
    deal.company,
    deal.contact_first_name,
    deal.contact_last_name,
    deal.contact_email,
    deal.contact_phone,
    deal.event_type,
    deal.venue_name,
    deal.venue_address,
    deal.package_name,
    deal.payment_status,
    deal.stage,
    deal.notes,
    deal.lead_source,
    deal.how_did_you_hear,
    deal.event_date,
  ]
    .filter(
      (v) => v !== null && v !== undefined && String(v).trim() !== "",
    )
    .map((v) => String(v).toLowerCase())
    .join(" ");
}

// Split query on whitespace; every term must appear in the haystack.
export function matchesQuery(deal: Deal, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const haystack = searchHaystack(deal);
  return q.split(/\s+/).every((term) => haystack.includes(term));
}
