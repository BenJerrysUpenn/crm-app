export type Deal = {
  id: number;
  stage: string;
  company: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  day_of_contact_name: string | null;
  day_of_contact_phone: string | null;
  event_date: string | null;
  event_start_time: string | null;
  event_end_time: string | null;
  event_type: string | null;
  event_name: string | null;
  venue_name: string | null;
  venue_address: string | null;
  guest_count: number | null;
  package_name: string | null;
  flavors: string | null;
  toppings: string | null;
  extras: string | null;
  staff_count: number | null;
  setup_count: number | null;
  labor_hours: number | null;
  round_trip_miles: number | null;
  drive_minutes: number | null;
  transport_mode: string | null;
  mileage_charge_eligible: number | null;
  departure_time: string | null;
  arrival_time: string | null;
  minimum_order_override: number;
  total_with_tax: number | null;
  subtotal_pretax: number | null;
  amount_paid: number | null;
  signed_contract_total: number | null;
  deposit_amount: number | null;
  payment_status: string;
  boomerang_reason: string | null;
  last_outbound_at: string | null;
  next_action_verb: string | null;
  next_action_reason: string | null;
  next_action_category: string | null;
  next_action_computed_at: string | null;
  is_active: number;
  archived: number;
  tax_exempt: number;
  notes: string | null;
  picklist_notes: string | null;
  lead_source: string | null;
  how_did_you_hear: string | null;
  created_at: string;
  updated_at: string;
};

export type ThreadMessage = {
  id: number;
  deal_id: number;
  gmail_message_id: string;
  direction: "inbound" | "outbound";
  sender: string | null;
  recipient: string | null;
  sent_at: string | null;
  subject: string | null;
  body: string | null;
  body_full: string | null;
};

export type QuoteJobStatus = "pending" | "running" | "done" | "error";
export type QuoteJobKind =
  | "quote"
  | "picklist"
  | "decline_below_min"
  | "decline_too_far"
  | "followup"
  | "retriage";

export type QuoteJob = {
  id: number;
  deal_id: number;
  status: QuoteJobStatus;
  kind: QuoteJobKind;
  created_at: string;
  processed_at: string | null;
  requested_by: string | null;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error_message: string | null;
  run_log: string | null;
};
