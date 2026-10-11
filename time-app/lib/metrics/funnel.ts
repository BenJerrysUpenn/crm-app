// Funnel metrics (bj-finance #671; definitions follow #422 Funnels tab and
// #445 Weekly scoreboard): new enquiries, outreach sent and replied, and
// quote-to-booking. All from the CRM tables the page can already read.
//
//   Leads             deals created that week (New York day of created_at),
//                     archived rows left out. By source: form, email, phone,
//                     other (walk-in, other, unknown).
//   Outreach sent     outreach_events 'sequenced' rows: one per email sent.
//   Outreach replied  outreach_events 'replied' rows.
//   Quote to booking  deals created that month that reached a quote (at or
//                     past Sent Quote now, or Sent Quote in their stage
//                     history), and how many of those are booked (catering.ts:
//                     isBooked, which does not trust Event Complete on a
//                     future event). Recent months are still open: quotes
//                     not yet decided count as not booked.

import { mondayOf, monthStart, nyDay } from "./dates.ts";
import { CLOSED_STAGES, QUOTED_STAGES, createdDay, isBooked, type DealRow } from "./catering.ts";

export type LeadSource = "form" | "email" | "phone" | "other";
export const LEAD_SOURCES: LeadSource[] = ["form", "email", "phone", "other"];

export function leadSource(d: Pick<DealRow, "source">): LeadSource {
  return d.source === "form" || d.source === "email" || d.source === "phone" ? d.source : "other";
}

export type LeadWeek = { week: string; total: number } & Record<LeadSource, number>;

export function leadsByWeek(deals: DealRow[], weeks: string[]): LeadWeek[] {
  const rows = new Map(weeks.map((w) => [w, { week: w, total: 0, form: 0, email: 0, phone: 0, other: 0 } as LeadWeek]));
  for (const d of deals) {
    if (d.archived) continue;
    const day = createdDay(d);
    if (!day) continue;
    const row = rows.get(mondayOf(day));
    if (!row) continue;
    row.total++;
    row[leadSource(d)]++;
  }
  return weeks.map((w) => rows.get(w)!);
}

export type OutreachEventRow = { event: string; occurred_at: string };
export type OutreachWeek = { week: string; sent: number; replied: number };

export function outreachByWeek(events: OutreachEventRow[], weeks: string[]): OutreachWeek[] {
  const rows = new Map(weeks.map((w) => [w, { week: w, sent: 0, replied: 0 }]));
  for (const e of events) {
    const row = rows.get(mondayOf(nyDay(e.occurred_at)));
    if (!row) continue;
    if (e.event === "sequenced") row.sent++;
    else if (e.event === "replied") row.replied++;
  }
  return weeks.map((w) => rows.get(w)!);
}

export type QuoteCohort = { month: string; created: number; quoted: number; booked: number; lost: number };

export function quoteToBooking(
  deals: DealRow[],
  months: string[],
  today: string,
  history: { quotedBefore: Set<number>; bookedBefore: Set<number> },
): QuoteCohort[] {
  const rows = new Map(months.map((m) => [m, { month: m, created: 0, quoted: 0, booked: 0, lost: 0 }]));
  for (const d of deals) {
    if (d.archived) continue;
    const day = createdDay(d);
    if (!day) continue;
    const row = rows.get(monthStart(day));
    if (!row) continue;
    row.created++;
    const booked = isBooked(d, today, history.bookedBefore);
    const quoted = booked || QUOTED_STAGES.includes(d.stage) || history.quotedBefore.has(d.id);
    if (!quoted) continue;
    row.quoted++;
    if (booked) row.booked++;
    else if (CLOSED_STAGES.includes(d.stage)) row.lost++;
  }
  return months.map((m) => rows.get(m)!);
}

/** booked / quoted over a run of cohorts, three places; null with no quotes. */
export function conversion(cohorts: QuoteCohort[]): number | null {
  const quoted = cohorts.reduce((s, c) => s + c.quoted, 0);
  if (quoted === 0) return null;
  return Math.round((cohorts.reduce((s, c) => s + c.booked, 0) / quoted) * 1000) / 1000;
}
