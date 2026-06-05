import type { Deal } from "@/lib/types";
import { daysUntilEvent, fmtEasternDateTime } from "@/lib/dateFormat";

export const FOLLOWUP_GRACE_DAYS = 2;
const GRACE_MS = FOLLOWUP_GRACE_DAYS * 24 * 60 * 60 * 1000;

// Pre-event reminder window. Booked Paid deals whose event is this many
// calendar days away (or fewer, including past) get an "event soon"
// badge.
export const EVENT_REMINDER_WINDOW_DAYS = 2;

// True when the payment milestone the boomerang_reason is chasing has
// already been met. Example: a deal sits at Booked Paid with
// boomerang_reason='balance_due', but payment_status='Paid in Full'.
// Nothing left to chase, no badge.
function boomerangSatisfied(deal: Deal): boolean {
  const reason = deal.boomerang_reason;
  const payment = deal.payment_status;
  if (!reason) return true;
  if (reason === "balance_due" && payment === "Paid in Full") return true;
  if (
    reason === "deposit_due" &&
    (payment === "Deposit Paid" || payment === "Paid in Full")
  ) {
    return true;
  }
  return false;
}

// Show the boomerang badge when the catering automation has flagged the
// deal, the payment milestone hasn't been satisfied, AND more than 2
// days have elapsed since the last outbound.
export function shouldShowBoomerang(deal: Deal, now: Date = new Date()): boolean {
  if (!deal.boomerang_reason) return false;
  if (boomerangSatisfied(deal)) return false;
  if (!deal.last_outbound_at) return true;
  const last = Date.parse(deal.last_outbound_at);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= GRACE_MS;
}

// True for Booked Paid deals whose event is today, tomorrow, or the
// day after. These get a separate "event soon" badge so Alina sends a
// day-before reminder.
export function shouldShowEventReminder(
  deal: Deal,
  now: Date = new Date(),
): boolean {
  if (deal.stage !== "Booked Paid") return false;
  const days = daysUntilEvent(deal.event_date, now);
  if (days === null) return false;
  return days >= 0 && days <= EVENT_REMINDER_WINDOW_DAYS;
}

export function eventReminderLabel(
  deal: Deal,
  now: Date = new Date(),
): string {
  const days = daysUntilEvent(deal.event_date, now);
  if (days === null) return "";
  if (days === 0) return "Event today";
  if (days === 1) return "Event tomorrow";
  return `Event in ${days} days`;
}

// Re-export EST timestamp formatter under the old name so call sites
// don't have to change.
export function formatFollowupDate(iso: string | null): string {
  if (!iso) return "never";
  return fmtEasternDateTime(iso) || iso;
}

// Whole calendar days since `iso`. Negative if iso is in the future,
// null if iso is missing or unparseable.
export function daysSince(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000));
}

// Short chip text for the days-since-last-outbound indicator.
// 0 → "today", 1 → "1d", 14 → "14d", etc. Null when no outbound yet.
export function lastOutboundChipText(deal: Deal, now: Date = new Date()): string | null {
  const d = daysSince(deal.last_outbound_at, now);
  if (d === null) return "never";
  if (d <= 0) return "today";
  return `${d}d`;
}
