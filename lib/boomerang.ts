// Follow-up and event-reminder helpers for the deal cards.
//
// The boomerang badge that used to live here is gone: bj-finance #333 retired
// the automatic boomerang follow-up, and migration 018b drops
// `deals.boomerang_reason`. Card staleness is now driven purely by
// `last_outbound_at`. See bj-finance #466.
import type { Deal } from "@/lib/types";
import { daysUntilEvent, fmtEasternDateTime } from "@/lib/dateFormat";

// Pre-event reminder window. Booked Paid deals whose event is this many
// calendar days away (or fewer, including past) get an "event soon"
// badge.
export const EVENT_REMINDER_WINDOW_DAYS = 2;

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
