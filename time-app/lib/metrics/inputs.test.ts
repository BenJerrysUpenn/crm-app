// Hours, funnel and forward-cash inputs for the Metrics page (bj-finance #671).
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { labourByWeek, labourPct, salesPerHour, type PersonRow } from "./labour.ts";
import { conversion, leadsByWeek, outreachByWeek, quoteToBooking } from "./funnel.ts";
import { forwardCatering } from "./forward.ts";
import type { DealRow } from "./catering.ts";

const people = new Map<string, PersonRow>([
  ["sam", { id: "sam", hourly_rate: 15, pay_type: "hourly" }],
  ["gm", { id: "gm", hourly_rate: null, pay_type: "salaried" }],
  ["owner", { id: "owner", hourly_rate: null, pay_type: null }],
]);

test("hours split in-store and catering by the shift's deal; cost only for hourly staff with a rate", () => {
  const shiftDeal = new Map<number, number | null>([[1, null], [2, 9001]]);
  const { weeks, openPunches } = labourByWeek(
    [
      // Monday Oct 5, 4h in-store at $15
      { employee_id: "sam", clock_in_at: "2026-10-05T16:00:00Z", clock_out_at: "2026-10-05T20:00:00Z", shift_id: 1 },
      // 3h catering at $15
      { employee_id: "sam", clock_in_at: "2026-10-06T16:00:00Z", clock_out_at: "2026-10-06T19:00:00Z", shift_id: 2 },
      // the GM, 8h in-store, salaried
      { employee_id: "gm", clock_in_at: "2026-10-07T13:00:00Z", clock_out_at: "2026-10-07T21:00:00Z", shift_id: null },
      // an owner, 2h, no rate
      { employee_id: "owner", clock_in_at: "2026-10-11T15:00:00Z", clock_out_at: "2026-10-11T17:00:00Z", shift_id: null },
      // Sunday 11pm New York is still that week, though it is Monday in UTC
      { employee_id: "sam", clock_in_at: "2026-10-12T03:00:00Z", clock_out_at: "2026-10-12T04:00:00Z", shift_id: null },
      // still clocked in
      { employee_id: "sam", clock_in_at: "2026-10-09T16:00:00Z", clock_out_at: null, shift_id: null },
    ],
    shiftDeal,
    people,
    ["2026-10-05"],
  );
  assert.equal(openPunches, 1);
  assert.deepEqual(weeks[0], {
    week: "2026-10-05",
    inStoreHours: 15,
    cateringHours: 3,
    inStoreHourlyCost: 75,
    cateringHourlyCost: 45,
    salariedHours: 8,
    noRateHours: 2,
  });
});

test("sales per hour and labour % are unknown, never zero or infinite, without sales or hours", () => {
  assert.equal(salesPerHour(3000, 15), 200);
  assert.equal(salesPerHour(3000, 0), null);
  assert.equal(salesPerHour(null, 15), null);
  assert.equal(labourPct(75, 3000), 0.025);
  assert.equal(labourPct(75, 0), null);
});

function d(over: Partial<DealRow>): DealRow {
  return {
    id: 1, stage: "Open", payment_status: "None", event_date: "2026-11-01", created_at: "2026-10-06T15:00:00Z",
    subtotal_pretax: 500, total_with_tax: 540, amount_paid: 0, company: "Co", source: "form", archived: 0, ...over,
  };
}

test("leads are deals created that week, by source; archived deals left out", () => {
  const weeks = leadsByWeek(
    [
      d({ id: 1, source: "form" }),
      d({ id: 2, source: "phone", created_at: "2026-10-11T23:00:00Z" }), // Sunday 7pm New York
      d({ id: 3, source: "walk_in" }),
      d({ id: 4, source: null, created_at: "2026-09-30T12:00:00Z" }),
      d({ id: 5, archived: 1 }),
    ],
    ["2026-09-28", "2026-10-05"],
  );
  assert.deepEqual(weeks, [
    { week: "2026-09-28", total: 1, form: 0, email: 0, phone: 0, other: 1 },
    { week: "2026-10-05", total: 3, form: 1, email: 0, phone: 1, other: 1 },
  ]);
});

test("outreach: 'sequenced' is an email sent, 'replied' a reply; other events ignored", () => {
  const weeks = outreachByWeek(
    [
      { event: "sequenced", occurred_at: "2026-10-05T14:00:00Z" },
      { event: "sequenced", occurred_at: "2026-10-06T14:00:00Z" },
      { event: "replied", occurred_at: "2026-10-07T14:00:00Z" },
      { event: "bounced", occurred_at: "2026-10-07T14:00:00Z" },
      { event: "sequenced", occurred_at: "2026-09-01T14:00:00Z" },
    ],
    ["2026-10-05"],
  );
  assert.deepEqual(weeks, [{ week: "2026-10-05", sent: 2, replied: 1 }]);
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
      { id: 1, employee_id: "sam", starts_at: "2026-10-11T14:00:00Z", ends_at: "2026-10-11T18:00:00Z", deal_id: null },
      { id: 2, employee_id: "gm", starts_at: "2026-10-11T14:00:00Z", ends_at: "2026-10-11T18:00:00Z", deal_id: null },
      { id: 3, employee_id: null, starts_at: "2026-10-12T14:00:00Z", ends_at: "2026-10-12T18:00:00Z", deal_id: 1 },
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
