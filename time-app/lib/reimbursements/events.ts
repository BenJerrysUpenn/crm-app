// Catering Events as staff recognise them, and the Reason a Travel
// Reimbursement records (bj-finance #210).
//
// A Catering Event is one booked catering deal: its date, start time, venue or
// company, and address (GLOSSARY.md). The picker lists every one from the last
// 365 days up to today, newest first, never a future one (ruling 17), labelled
// so staff recognise it from the picklist and never by deal id (16). Staff
// cannot read public.deals (RLS, managers only), so the events route reads it
// with the service role and returns only these fields.
//
// Pure and dependency-free, so `node --test` runs it and the browser can use it.

import { addDays } from "../coverage.ts";

/** Deal stages that are a booked Catering Event, held or still to be held. */
export const CATERING_EVENT_STAGES = ["Booked Unpaid", "Booked Paid", "Event Complete"];

/** How far back the picker reaches, in days (ruling 17). */
export const EVENT_LOOKBACK_DAYS = 365;

/** The deal columns the picker reads, and nothing else. */
export const EVENT_DEAL_COLUMNS = "id, stage, event_date, event_start_time, company, venue_name, venue_address";

export type EventDeal = {
  id: number;
  stage: string | null;
  event_date: string | null;
  event_start_time: string | null;
  company: string | null;
  venue_name: string | null;
  venue_address: string | null;
};

export type CateringEvent = {
  /** The deal id: kept to record the Reason, never shown to staff. */
  id: number;
  date: string;
  start_time: string | null;
  company: string | null;
  venue: string | null;
  address: string | null;
};

/** The picker's dates: from 365 days before today up to today, inclusive. */
export function eventWindow(today: string): { from: string; to: string } {
  return { from: addDays(today, -EVENT_LOOKBACK_DAYS), to: today };
}

function clean(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

/** "HH:MM" or "HH:MM:SS" to "HH:MM", or null. */
function hhmm(s: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((s ?? "").trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/** The booked Catering Events in the picker's window, newest first. */
export function cateringEventsFromDeals(deals: EventDeal[], today: string): CateringEvent[] {
  const { from, to } = eventWindow(today);
  return deals
    .filter((d) => CATERING_EVENT_STAGES.includes(d.stage ?? ""))
    .map((d) => ({ d, date: /^\d{4}-\d{2}-\d{2}/.exec(d.event_date ?? "")?.[0] ?? null }))
    .filter((x): x is { d: EventDeal; date: string } => x.date !== null && x.date >= from && x.date <= to)
    .map(({ d, date }) => ({
      id: d.id,
      date,
      start_time: hhmm(d.event_start_time),
      company: clean(d.company),
      venue: clean(d.venue_name),
      address: clean(d.venue_address),
    }))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : (b.start_time ?? "").localeCompare(a.start_time ?? "")));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-03" -> "Sat Oct 3, 2026". A calendar day: no time zone involved. */
export function dateText(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[day]} ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "14:00" -> "2:00 PM". */
export function timeText(hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Venue and company as one phrase: "Acme at Houston Hall", or whichever there is. */
function where(e: Pick<CateringEvent, "company" | "venue">): string | null {
  if (e.company && e.venue && e.company.toLowerCase() !== e.venue.toLowerCase()) return `${e.company} at ${e.venue}`;
  return e.company ?? e.venue;
}

/** How staff see a Catering Event: date, start time, venue/company, address. */
export function eventLabel(e: CateringEvent): string {
  return [dateText(e.date), e.start_time ? timeText(e.start_time) : null, where(e), e.address]
    .filter((p): p is string => !!p)
    .join(", ");
}

/** Events whose venue, company or address contains `query` (any case). */
export function searchEvents(events: CateringEvent[], query: string): CateringEvent[] {
  const q = query.trim().toLowerCase();
  if (!q) return events;
  return events.filter((e) => [e.venue, e.company, e.address].some((f) => (f ?? "").toLowerCase().includes(q)));
}

export type ReasonKind = "errands" | "catering_event";

export type ReasonFields = { reason_kind: ReasonKind | string; reason_note: string | null; event_label: string | null };

/** The Reason as one line, for lists, notices and the receipts@ email. */
export function reasonLabel(r: ReasonFields): string {
  if (r.reason_kind === "errands") return r.reason_note ? `Groceries / errands: ${r.reason_note}` : "Groceries / errands";
  return `Catering Event: ${r.event_label ?? "(event not recorded)"}`;
}

type Live = { id: number; deal_id: number | null; status: string; full_name: string | null; miles: number | string };

/**
 * For each reimbursement on a Catering Event, the other live ones on the same
 * event (ruling 24): two people may each have driven, so the queue shows it
 * and never blocks it. A Rejected one is not live.
 */
export function alsoOnSameEvent(items: Live[]): Map<number, { full_name: string | null; miles: number }[]> {
  const live = items.filter((i) => i.deal_id != null && i.status !== "rejected");
  const out = new Map<number, { full_name: string | null; miles: number }[]>();
  for (const i of live) {
    const others = live
      .filter((o) => o.id !== i.id && o.deal_id === i.deal_id)
      .map((o) => ({ full_name: o.full_name, miles: Number(o.miles) }));
    if (others.length) out.set(i.id, others);
  }
  return out;
}
