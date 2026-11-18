// Hours, funnel and forward-cash inputs for the Metrics page (bj-finance #671).
// Weeks run Sunday to Saturday (Alina, 2026-11-18). Invented figures; crm-app
// is public.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { labourByWeek, punchWork, salesPerHour, type PersonRow, type PunchRow } from "./labour.ts";
import { conversion, leadsByWeek, outreachByWeek, quoteToBooking } from "./funnel.ts";
import { forwardCatering } from "./forward.ts";
import type { DealRow } from "./catering.ts";
import type { LaborShift } from "../controlBoard/schedule.ts";

const people = new Map<string, PersonRow>([
  ["sam", { id: "sam", hourly_rate: 15, pay_type: "hourly" }],
  ["kim", { id: "kim", hourly_rate: 20, pay_type: "hourly" }],
  ["gm", { id: "gm", hourly_rate: null, pay_type: "salaried" }],
  ["owner", { id: "owner", hourly_rate: null, pay_type: null }],
]);

const at = (date: number, hour: number) => `2026-10-${String(date).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;
/** A shift on Oct `date` 2026, `from` to `to` UTC hours. */
const shift = (id: number, employee_id: string | null, date: number, from: number, to: number, position: string | null, deal_id: number | null = null): LaborShift => ({
  id, employee_id, starts_at: at(date, from), ends_at: at(date, to), position, deal_id,
});
/** A closed punch on Oct `date` 2026, `from` to `to` UTC hours. */
const punch = (employee_id: string, date: number, from: number, to: number, shift_id: number | null = null) => ({
  employee_id, clock_in_at: at(date, from), clock_out_at: at(date, to), shift_id,
});

// The week of Sunday Oct 4 2026 (New York is UTC-4 then).
const WEEK = ["2026-10-04"];
const MARKETING_DEAL = 9002;

test("a punch's work is its shift's: Marketing or a marketing deal's shift is marketing, else a Catering shift is catering, else in-store", () => {
  const shifts = [
    shift(1, "sam", 5, 16, 20, "Scooper"),
    shift(2, "sam", 6, 16, 19, "Catering", 9001),
    shift(3, "sam", 7, 16, 18, "Marketing"),
    // A Catering shift on a marketing deal is marketing work.
    shift(4, "sam", 8, 16, 17, "Catering", MARKETING_DEAL),
    // On a catering deal but not a Catering shift: in-store, by the shift's position.
    shift(5, "sam", 9, 16, 18, "Scooper", 9001),
  ];
  const punches: PunchRow[] = [
    punch("sam", 5, 16, 20, 1), // Monday Oct 5, 4h in-store at $15
    punch("sam", 6, 16, 19, 2), // 3h catering
    punch("sam", 7, 16, 18, 3), // 2h marketing
    punch("sam", 8, 16, 17, 4), // 1h marketing
    punch("sam", 9, 16, 18, 5), // 2h in-store
    punch("gm", 7, 13, 21), // the GM, 8h in-store, salaried
    punch("owner", 10, 15, 17), // an owner, 2h, no rate
    // Saturday 11pm New York is still that week, though it is Sunday in UTC.
    punch("sam", 11, 3, 4),
    // Sunday Oct 11 in New York starts the next week: not this one.
    punch("sam", 11, 15, 17),
    // still clocked in
    { employee_id: "sam", clock_in_at: at(9, 16), clock_out_at: null, shift_id: null },
  ];
  const { weeks, openPunches } = labourByWeek(punches, shifts, new Set([MARKETING_DEAL]), people, WEEK);
  assert.equal(openPunches, 1);
  assert.deepEqual(weeks[0], {
    week: "2026-10-04",
    inStoreHours: 17,
    cateringHours: 3,
    marketingHours: 3,
    inStoreHourlyCost: 105,
    cateringHourlyCost: 45,
    marketingHourlyCost: 45,
    salariedHours: 8,
    noRateHours: 2,
  });
});

test("a punch with no shift is in-store, except the part overlapping the same person's catering or marketing shift that nobody punched", () => {
  const shifts = [
    shift(10, "sam", 6, 14, 18, "Catering"), // nobody punched it
    shift(11, "sam", 7, 14, 16, "Marketing"), // nobody punched it
    shift(12, "sam", 9, 14, 18, "Catering"), // sam punched it for part of the time
    shift(13, "sam", 10, 14, 18, "Scooper"), // in-store work: never taken from
  ];
  const punches: PunchRow[] = [
    punch("sam", 6, 12, 17), // partial: 14:00-17:00 is the catering shift, 3h; the other 2h in-store
    punch("sam", 7, 14, 16), // full: all 2h are the marketing shift
    punch("sam", 8, 14, 18), // none: no work shift that day, 4h in-store
    punch("kim", 6, 14, 18), // someone else's catering shift is not hers: 4h in-store at $20
    punch("sam", 9, 14, 16, 12), // on the shift: 2h catering
    punch("sam", 9, 16, 18), // clocked back in without picking it: the shift has a punch, so in-store
    punch("sam", 10, 14, 18), // over an in-store shift: in-store
  ];
  const { weeks } = labourByWeek(punches, shifts, new Set(), people, WEEK);
  assert.deepEqual(weeks[0], {
    week: "2026-10-04",
    inStoreHours: 2 + 4 + 4 + 2 + 4,
    cateringHours: 3 + 2,
    marketingHours: 2,
    inStoreHourlyCost: 12 * 15 + 4 * 20,
    cateringHourlyCost: 5 * 15,
    marketingHourlyCost: 2 * 15,
    salariedHours: 0,
    noRateHours: 0,
  });
});

test("punchWork: an unlinked punch over two unpunched work shifts takes each overlap, and never more hours than it has", () => {
  const unpunched = [shift(20, "sam", 6, 14, 16, "Catering"), shift(21, "sam", 6, 16, 18, "Marketing")];
  const shifts = new Map(unpunched.map((s) => [s.id, s]));
  assert.deepEqual(punchWork(punch("sam", 6, 13, 18), shifts, unpunched, new Set()), { catering: 2, marketing: 2, inStore: 1 });
  // Wholly inside one shift: all of it that work, nothing in-store.
  assert.deepEqual(punchWork(punch("sam", 6, 14, 15), shifts, unpunched, new Set()), { catering: 1 });
  // No overlap: all in-store.
  assert.deepEqual(punchWork(punch("sam", 6, 10, 12), shifts, unpunched, new Set()), { inStore: 2 });
  // Linked to a shift: that shift's work, whatever else it overlaps.
  assert.deepEqual(punchWork(punch("sam", 6, 14, 18, 21), shifts, unpunched, new Set()), { marketing: 4 });
  // Linked to an in-store shift: in-store.
  const scoop = shift(22, "sam", 6, 14, 18, "Scooper");
  assert.deepEqual(punchWork(punch("sam", 6, 14, 18, 22), new Map([[22, scoop]]), unpunched, new Set()), { inStore: 4 });
  // Two unpunched work shifts that overlap each other (14:00-17:00 and 15:00-18:00, 6h of shift between them):
  // the 4h punch is split among them but is never counted as more than its 4 hours.
  const overlapping = [shift(23, "sam", 6, 14, 17, "Catering"), shift(24, "sam", 6, 15, 18, "Marketing")];
  const split = punchWork(punch("sam", 6, 14, 18), new Map(overlapping.map((s) => [s.id, s])), overlapping, new Set());
  assert.equal((split.catering ?? 0) + (split.marketing ?? 0) + (split.inStore ?? 0), 4);
  assert.equal(split.inStore, undefined, "all of it overlaps the work shifts: none in-store");
});

test("salaried staff and people with no rate on catering or marketing work: hours counted as that work, never costed", () => {
  const shifts = [
    shift(30, "gm", 6, 14, 17, "Catering"),
    shift(31, "owner", 7, 14, 16, "Marketing"),
    shift(32, "gm", 8, 14, 16, "Catering"), // nobody punched it
  ];
  const { weeks } = labourByWeek([punch("gm", 6, 14, 17, 30), punch("owner", 7, 14, 16, 31), punch("gm", 8, 13, 16)], shifts, new Set(), people, WEEK);
  assert.deepEqual(weeks[0], {
    week: "2026-10-04",
    inStoreHours: 1,
    cateringHours: 3 + 2,
    marketingHours: 2,
    inStoreHourlyCost: 0,
    cateringHourlyCost: 0,
    marketingHourlyCost: 0,
    salariedHours: 3 + 3,
    noRateHours: 2,
  });
});

test("sales per hour is unknown, never zero or infinite, without sales or hours", () => {
  assert.equal(salesPerHour(3000, 15), 200);
  assert.equal(salesPerHour(3000, 0), null);
  assert.equal(salesPerHour(null, 15), null);
});

function d(over: Partial<DealRow>): DealRow {
  return {
    id: 1, stage: "Open", payment_status: "None", event_date: "2026-11-01", created_at: "2026-10-06T15:00:00Z",
    subtotal_pretax: 500, total_with_tax: 540, amount_paid: 0, company: "Co", source: "form", archived: 0, ...over,
  };
}

test("leads are deals created that Sunday-to-Saturday week, by source; archived deals left out", () => {
  const weeks = leadsByWeek(
    [
      d({ id: 1, source: "form" }),
      d({ id: 2, source: "phone", created_at: "2026-10-11T02:00:00Z" }), // Saturday 10pm New York, Sunday in UTC
      d({ id: 3, source: "walk_in" }),
      d({ id: 4, source: null, created_at: "2026-09-30T12:00:00Z" }),
      d({ id: 5, archived: 1 }),
      d({ id: 6, source: "phone", created_at: "2026-10-11T14:00:00Z" }), // Sunday: the next week
    ],
    ["2026-09-27", "2026-10-04"],
  );
  assert.deepEqual(weeks, [
    { week: "2026-09-27", total: 1, form: 0, email: 0, phone: 0, other: 1 },
    { week: "2026-10-04", total: 3, form: 1, email: 0, phone: 1, other: 1 },
  ]);
});

test("outreach: 'sequenced' is an email sent, 'replied' a reply; other events ignored; Sunday starts the week", () => {
  const weeks = outreachByWeek(
    [
      { event: "sequenced", occurred_at: "2026-10-04T14:00:00Z" }, // Sunday: the week's first day
      { event: "sequenced", occurred_at: "2026-10-06T14:00:00Z" },
      { event: "replied", occurred_at: "2026-10-07T14:00:00Z" },
      { event: "bounced", occurred_at: "2026-10-07T14:00:00Z" },
      { event: "sequenced", occurred_at: "2026-09-01T14:00:00Z" },
      { event: "sequenced", occurred_at: "2026-10-03T14:00:00Z" }, // Saturday: the week before
    ],
    ["2026-10-04"],
  );
  assert.deepEqual(weeks, [{ week: "2026-10-04", sent: 2, replied: 1 }]);
});

test("quote to booking: quoted = at or past Sent Quote, or Sent Quote in history; booked never trusts a future Event Complete", () => {
  const today = "2026-10-10";
  const cohorts = quoteToBooking(
    [
      d({ id: 1, stage: "Sent Quote" }),
      d({ id: 2, stage: "Booked Paid", payment_status: "Paid in Full", amount_paid: 540 }),
      d({ id: 3, stage: "Closed Lost" }), // quoted, then lost (history)
      d({ id: 4, stage: "Closed Below Min" }), // never quoted
      d({ id: 5, stage: "Event Complete", event_date: "2026-12-01" }), // the 10-06 defect: quoted, not booked
      d({ id: 6, stage: "Open" }),
      d({ id: 7, stage: "Booked Unpaid", created_at: "2026-09-02T12:00:00Z" }),
    ],
    ["2026-09-01", "2026-10-01"],
    today,
    { quotedBefore: new Set([3]), bookedBefore: new Set() },
  );
  assert.deepEqual(cohorts, [
    { month: "2026-09-01", created: 1, quoted: 1, booked: 1, lost: 0 },
    { month: "2026-10-01", created: 6, quoted: 4, booked: 1, lost: 1 },
  ]);
  assert.equal(conversion(cohorts), 0.4);
  assert.equal(conversion([]), null);
});

test("forward 14 days: catering balances on their event day, scheduled hourly wages on the shift day", () => {
  const today = "2026-10-10";
  const out = forwardCatering(
    [
      d({ id: 1, stage: "Booked Unpaid", event_date: "2026-10-12", total_with_tax: 540, amount_paid: 100, payment_status: "Deposit Paid" }),
      d({ id: 2, stage: "Booked Unpaid", event_date: "2026-10-01", total_with_tax: 300 }), // overdue: not on a day
      d({ id: 3, stage: "Booked Unpaid", event_date: "2026-10-30", total_with_tax: 300 }), // past the 14 days
    ],
    [
      { id: 1, employee_id: "sam", starts_at: "2026-10-11T14:00:00Z", ends_at: "2026-10-11T18:00:00Z", position: null, deal_id: null },
      { id: 2, employee_id: "gm", starts_at: "2026-10-11T14:00:00Z", ends_at: "2026-10-11T18:00:00Z", position: null, deal_id: null },
      { id: 3, employee_id: null, starts_at: "2026-10-12T14:00:00Z", ends_at: "2026-10-12T18:00:00Z", position: "Catering", deal_id: 1 },
    ],
    people,
    today,
  );
  assert.equal(out.days.length, 14);
  assert.equal(out.days[0].day, "2026-10-10");
  assert.equal(out.days[13].day, "2026-10-23");
  assert.equal(out.days[2].cateringIn, 440);
  assert.equal(out.days[1].scheduledWages, 60);
  assert.equal(out.overdue, 300);
  assert.equal(out.uncostedShifts, 2);
});
