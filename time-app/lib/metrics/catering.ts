// Catering, counted by EVENT DATE (bj-finance #671, ruling M4), from the
// CRM's deals table.
//
// BOOKED. A deal counts when there is evidence it is booked: stage Booked
// Unpaid or Booked Paid, a payment recorded on it, or Event Complete for an
// event that has happened. Booked Unpaid, Booked Paid and Event Complete are
// one class here, so no number depends on which of the three a deal is in.
//
// THE 10-06 SWEEP DEFECT. On 2026-10-06 the catering sweep moved 8 deals
// with FUTURE event dates to Event Complete, several unpaid; they were not
// reverted. Event Complete on a future event is therefore not evidence of a
// booking. Such a deal counts only if a payment is recorded or its stage
// history (deal_events) shows it was booked before; otherwise it is left out
// and listed as "suspect" so the page can say how many and which. Nothing
// here repairs the rows.

import { monthEnd, monthStart, nyDay } from "./dates.ts";
import { round2 } from "./round.ts";

export type DealRow = {
  id: number;
  stage: string;
  payment_status: string | null;
  event_date: string | null;
  created_at: string | null;
  subtotal_pretax: number | null;
  total_with_tax: number | null;
  amount_paid: number | null;
  company: string | null;
  source: string | null;
  archived: number | null;
};

export const BOOKED_STAGES = ["Booked Unpaid", "Booked Paid"];
export const CLOSED_STAGES = ["Closed Lost", "Closed Below Min", "Closed Marketing Event"];
/** Stages that mean a quote went out (a deal at or past Sent Quote). */
export const QUOTED_STAGES = ["Sent Quote", "Booked Unpaid", "Booked Paid", "Event Complete"];

/** The Philadelphia prepared-food rate, used only to back tax out of a total when the subtotal is missing. */
const PHILLY_TAX = 0.08;

export type BookedEvidence = "stage" | "payment" | "past_event_complete" | "stage_history" | "suspect_event_complete" | null;

export function eventDay(d: Pick<DealRow, "event_date">): string | null {
  const raw = d.event_date?.trim();
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

function paid(d: DealRow): boolean {
  return (d.payment_status != null && d.payment_status !== "None") || (d.amount_paid ?? 0) > 0;
}

/**
 * Why a deal counts as booked, or null when it does not.
 * `bookedBefore` holds the ids whose stage history shows Booked Unpaid or Booked Paid.
 */
export function bookedEvidence(d: DealRow, today: string, bookedBefore?: Set<number>): BookedEvidence {
  if (CLOSED_STAGES.includes(d.stage)) return null;
  if (BOOKED_STAGES.includes(d.stage)) return "stage";
  if (paid(d)) return "payment";
  if (d.stage === "Event Complete") {
    const day = eventDay(d);
    if (day && day <= today) return "past_event_complete";
    if (bookedBefore?.has(d.id)) return "stage_history";
    return "suspect_event_complete";
  }
  return null;
}

export function isBooked(d: DealRow, today: string, bookedBefore?: Set<number>): boolean {
  const e = bookedEvidence(d, today, bookedBefore);
  return e !== null && e !== "suspect_event_complete";
}

/** Event Complete on a future event with no evidence of a booking (the 10-06 defect's signature). */
export function suspectDeals(deals: DealRow[], today: string, bookedBefore?: Set<number>): DealRow[] {
  return deals.filter((d) => !d.archived && bookedEvidence(d, today, bookedBefore) === "suspect_event_complete");
}

/** Sales value of a deal before tax: the subtotal, else the total with the 8% backed out (an estimate). */
export function cateringValue(d: Pick<DealRow, "subtotal_pretax" | "total_with_tax">): number | null {
  if (d.subtotal_pretax != null) return d.subtotal_pretax;
  if (d.total_with_tax != null) return round2(d.total_with_tax / (1 + PHILLY_TAX));
  return null;
}

export type CateringDays = {
  byDay: Record<string, number>;
  total: number;
  /** Booked deals whose value is estimated from the total (no subtotal). */
  estimatedIds: number[];
  /** Booked deals with no value at all: counted as 0. */
  missingValueIds: number[];
};

/** Booked catering sales by event day, from `from` to `to` inclusive. */
export function cateringByDay(deals: DealRow[], from: string, to: string, today: string, bookedBefore?: Set<number>): CateringDays {
  const out: CateringDays = { byDay: {}, total: 0, estimatedIds: [], missingValueIds: [] };
  for (const d of deals) {
    if (d.archived) continue;
    const day = eventDay(d);
    if (!day || day < from || day > to) continue;
    if (!isBooked(d, today, bookedBefore)) continue;
    const value = cateringValue(d);
    if (value == null) {
      out.missingValueIds.push(d.id);
      continue;
    }
    if (d.subtotal_pretax == null) out.estimatedIds.push(d.id);
    out.byDay[day] = round2((out.byDay[day] ?? 0) + value);
    out.total = round2(out.total + value);
  }
  return out;
}

// ---- AR -----------------------------------------------------------------------------

export type ArRow = { id: number; company: string | null; eventDay: string; total: number; paid: number; balance: number; overdue: boolean };

export type ArSummary = {
  /** Balances on events dated this calendar month, overdue or not. */
  dueThisMonth: number;
  overdueThisMonth: number;
  notYetDueThisMonth: number;
  /** Every balance on an event already past, any month. */
  overdue: number;
  /** Balances on events after this month. */
  laterMonths: number;
  /** Every open balance, oldest event first. */
  rows: ArRow[];
  /** Booked deals with no total to measure a balance against. */
  missingTotalIds: number[];
};

/**
 * Catering AR from the CRM: balance = total with tax - amount paid, nothing
 * owed once Paid in Full; due by the event date. The authority is Square
 * (bj-finance square_ar.py); this is the CRM's view of the same money.
 */
export function arSummary(deals: DealRow[], today: string, bookedBefore?: Set<number>): ArSummary {
  const month = monthStart(today);
  const out: ArSummary = { dueThisMonth: 0, overdueThisMonth: 0, notYetDueThisMonth: 0, overdue: 0, laterMonths: 0, rows: [], missingTotalIds: [] };
  for (const d of deals) {
    if (d.archived || !isBooked(d, today, bookedBefore)) continue;
    const day = eventDay(d);
    if (!day) continue;
    if (d.payment_status === "Paid in Full") continue;
    const total = d.total_with_tax ?? d.subtotal_pretax;
    if (total == null) {
      out.missingTotalIds.push(d.id);
      continue;
    }
    const paidSoFar = d.amount_paid ?? 0;
    const balance = round2(Math.max(0, total - paidSoFar));
    if (balance <= 0) continue;
    const overdue = day < today;
    out.rows.push({ id: d.id, company: d.company, eventDay: day, total, paid: paidSoFar, balance, overdue });
    if (overdue) out.overdue = round2(out.overdue + balance);
    if (monthStart(day) === month) {
      out.dueThisMonth = round2(out.dueThisMonth + balance);
      if (overdue) out.overdueThisMonth = round2(out.overdueThisMonth + balance);
      else out.notYetDueThisMonth = round2(out.notYetDueThisMonth + balance);
    } else if (day > monthEnd(today)) {
      out.laterMonths = round2(out.laterMonths + balance);
    }
  }
  out.rows.sort((a, b) => (a.eventDay < b.eventDay ? -1 : a.eventDay > b.eventDay ? 1 : a.id - b.id));
  return out;
}

/** The New York day a deal was created. */
export function createdDay(d: Pick<DealRow, "created_at">): string | null {
  return d.created_at ? nyDay(d.created_at) : null;
}
