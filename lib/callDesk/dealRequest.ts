// Coercion of an untrusted JSON body into a DealFormPayload, plus the one
// lookup both deal-intake routes need. Lifted out of
// app/api/call-desk/deals/route.ts unchanged so POST /api/deals can reuse it
// instead of growing a second, slightly-different copy.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealFormPayload } from "@/lib/callDesk/dealForm";
import { isManualDealSource } from "@/lib/dealIntake";

export function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter((s) => s.trim() !== "") : [];
}

export function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

export function int(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Coerce an untrusted JSON body into the payload shape. Unknown keys are
 *  dropped here, before anything reaches buildDealInsert. An unrecognised
 *  `source` becomes "" rather than passing through — the validator then says
 *  so in the field error, instead of a CHECK constraint failing at 3am. */
export function readPayload(body: Record<string, unknown>): DealFormPayload {
  const source = str(body.source).trim();
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
    source: isManualDealSource(source) ? source : "",
  };
}

/** Human label for the picked customer profile. Read from deal_form_options so
 *  the notes line says "Office admin", not "office_admin"; falls back to the
 *  client's label, then the raw value, so a missing migration cannot block a
 *  dry run. */
export async function profileLabelFor(
  supabase: SupabaseClient,
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
  return (data?.label as string | undefined) ?? (clientLabel || value);
}
