// The next 14 days of cash the CRM can see (bj-finance #671, W4, the
// catering side): catering balances falling due (by event date) and wages
// already scheduled. The finance feed adds the opening cash, recurring
// bills, other bills, tax and the in-store projection.
//
// Scheduled wages are hourly staff only (shift hours x hourly rate) and are
// placed on the day they are EARNED; they leave the bank on the next pay
// date. Unassigned shifts and salaried staff are not costed.

import { addDays, nyDay, spanHours } from "./dates.ts";
import { arSummary, type DealRow } from "./catering.ts";
import type { PersonRow } from "./labour.ts";
import { round2 } from "./round.ts";

export type ShiftRow = { id: number; employee_id: string | null; starts_at: string; ends_at: string; deal_id: number | null };

export type ForwardDay = { day: string; cateringIn: number; scheduledWages: number };

export function forwardCatering(
  deals: DealRow[],
  shifts: ShiftRow[],
  people: Map<string, PersonRow>,
  today: string,
  bookedBefore?: Set<number>,
): { days: ForwardDay[]; overdue: number; uncostedShifts: number } {
  const days = Array.from({ length: 14 }, (_, i) => ({ day: addDays(today, i), cateringIn: 0, scheduledWages: 0 }));
  const index = new Map(days.map((d) => [d.day, d]));
  const ar = arSummary(deals, today, bookedBefore);
  for (const r of ar.rows) {
    const d = index.get(r.eventDay);
    if (d) d.cateringIn = round2(d.cateringIn + r.balance);
  }
  let uncostedShifts = 0;
  for (const s of shifts) {
    const d = index.get(nyDay(s.starts_at));
    if (!d) continue;
    const person = s.employee_id ? people.get(s.employee_id) : undefined;
    if (!person || person.pay_type === "salaried" || !person.hourly_rate) {
      uncostedShifts++;
      continue;
    }
    const hours = spanHours(s.starts_at, s.ends_at);
    d.scheduledWages = round2(d.scheduledWages + hours * person.hourly_rate);
  }
  return { days, overdue: ar.overdue, uncostedShifts };
}
