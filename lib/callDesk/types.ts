// Call desk types (bj-finance #409).
//
// The shapes here mirror supabase/crm/001_call_desk.sql exactly — the view
// `call_desk_queue` and the `detail` JSON on an outreach_events 'called' row.
// Keep them in step with the migration; the migration is the source of truth.

/** One row of the `call_desk_queue` view. */
export type CallDeskRow = {
  prospect_id: number;
  name: string | null;
  company: string | null;
  title: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  category: string | null;
  status: string | null;
  last_outreach_at: string | null;
  ever_booked: boolean | null;
  deal_count: number | null;
  lifetime_value: number | null;
  last_event_date: string | null;
  notes: string | null;
  /** What the most recent touch of any kind was. */
  last_contact_type: "call" | "reply" | "email" | null;
  last_contact_at: string | null;
  last_call_event_id: number | null;
  last_call_at: string | null;
  last_disposition: Disposition | null;
  last_call_by: string | null;
  /** Set when a call was logged but never dispositioned. The UI must nag. */
  pending_disposition_event_id: number | null;
  calls_count: number;
  last_deal_id: number | null;
  last_deal_stage: string | null;
  last_event_type: string | null;
  last_deal_event_date: string | null;
  /** package_name of the last booked deal — "party type" in the old CRM. */
  party_type_booked: string | null;
  booked_event_type: string | null;
  booked_guest_count: number | null;
};

export type Disposition =
  | "no_answer"
  | "voicemail"
  | "spoke"
  | "interested"
  | "do_not_call";

/** The `detail` JSON carried by an outreach_events row with event = 'called'. */
export type CalledDetail = {
  by: string;
  via: "call_desk";
  started_at: string;
  disposition: Disposition | null;
  dispositioned_at?: string;
  duration_seconds?: number;
  note?: string;
  recording_path?: string;
  recording_uploaded_at?: string;
  consent_confirmed?: boolean;
};

export const DISPOSITIONS: {
  value: Disposition;
  label: string;
  description: string;
}[] = [
  {
    value: "no_answer",
    label: "No answer",
    description: "Rang out — nobody picked up and no voicemail was left.",
  },
  {
    value: "voicemail",
    label: "Left voicemail",
    description: "Reached voicemail and left a message.",
  },
  {
    value: "spoke",
    label: "Spoke to them",
    description: "Had a real conversation, no catering interest yet.",
  },
  {
    value: "interested",
    label: "Interested",
    description: "Wants a quote or a date — generate a deal next.",
  },
  {
    value: "do_not_call",
    label: "Do not call",
    description: "Asked to be left alone. Stops calls and outreach email.",
  },
];

export const DISPOSITION_VALUES: Disposition[] = DISPOSITIONS.map(
  (d) => d.value,
);

export function isDisposition(v: unknown): v is Disposition {
  return typeof v === "string" && (DISPOSITION_VALUES as string[]).includes(v);
}

export function dispositionLabel(v: string | null | undefined): string | null {
  if (!v) return null;
  return DISPOSITIONS.find((d) => d.value === v)?.label ?? v;
}
