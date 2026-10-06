// The event's Catering shift, made from the payroll page (Alina, 2026-10-05).
//
// The "crew didn't punch" card for an event with nobody on a Catering shift
// adds the punch and, in the same save, the shift it was worked on
// (POST /api/payroll/event-punch). The shift has the shape the CRM's catering
// shift writer gives a booked deal's shifts (crm-app root
// lib/cateringShifts.ts, planCateringShifts): position Catering, deal_id and
// a per-deal deal_slot set, live. The two are separate Next apps, so the
// shape is repeated here rather than imported; change them together.
//
// Pure, so the route test and this module agree on what is written.

import { CATERING_POSITION } from "./verify.ts";

export type EventDeal = { id: number; company?: string | null; venue_name?: string | null; venue_address?: string | null };

/** The deal's shifts as the route reads them: who is on each, and its slot. */
export type EventShiftRow = { id: number; employee_id: string | null; deal_slot: number | null };

export type NewEventShift = {
  employee_id: string;
  starts_at: string;
  ends_at: string;
  position: string;
  notes: string;
  published: true;
  deal_id: number;
  deal_slot: number;
};

export type EventShiftPlan = { action: "assign"; shiftId: number } | { action: "insert"; row: NewEventShift };

/**
 * Where the punch goes. An unassigned slot the CRM already made for the deal
 * is filled (its times stay as scheduled), so the event does not grow a second
 * shift for the same place in its crew; otherwise a new shift is made over the
 * punch's own hours, on the next free slot. Only Catering shifts on the deal
 * are passed in.
 */
export function planEventShift(input: {
  deal: EventDeal;
  eventShifts: EventShiftRow[];
  employeeId: string;
  clockInAt: string;
  clockOutAt: string;
}): EventShiftPlan {
  const open = input.eventShifts
    .filter((s) => !s.employee_id)
    .sort((a, b) => (a.deal_slot ?? Infinity) - (b.deal_slot ?? Infinity) || a.id - b.id)[0];
  if (open) return { action: "assign", shiftId: open.id };

  const slot = Math.max(0, ...input.eventShifts.map((s) => s.deal_slot ?? 0)) + 1;
  const where = input.deal.venue_name?.trim() || input.deal.company?.trim() || "Catering event";
  const notes = [
    `Added on the payroll page for booked deal #${input.deal.id}`,
    where,
    input.deal.venue_address?.trim() || null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    action: "insert",
    row: {
      employee_id: input.employeeId,
      starts_at: input.clockInAt,
      ends_at: input.clockOutAt,
      position: CATERING_POSITION,
      notes,
      published: true,
      deal_id: input.deal.id,
      deal_slot: slot,
    },
  };
}
