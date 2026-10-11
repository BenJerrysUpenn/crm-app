// The Catering Event picker and the Reason it records (bj-finance #210,
// rulings 12, 16, 17, 24): every booked Catering Event in the last 365 days up
// to today, newest first, labelled as staff know it (date, start time,
// venue/company, address; never the deal id), searchable by venue, company or
// address. Two people on one Catering Event is surfaced, never blocked.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  alsoOnSameEvent,
  cateringEventsFromDeals,
  eventLabel,
  eventWindow,
  reasonLabel,
  searchEvents,
  type CateringEvent,
} from "./events.ts";

const TODAY = "2026-10-08";

function deal(id: number, event_date: string, over: Record<string, unknown> = {}) {
  return {
    id,
    stage: "Event Complete",
    event_date,
    event_start_time: "14:00",
    company: `Company ${id}`,
    venue_name: `Venue ${id}`,
    venue_address: `${id} Walnut St, Philadelphia, PA`,
    ...over,
  };
}

test("eventWindow: the last 365 days, up to and including today", () => {
  assert.deepEqual(eventWindow(TODAY), { from: "2025-10-08", to: "2026-10-08" });
});

test("cateringEventsFromDeals: only booked events inside the window, newest first", () => {
  const events = cateringEventsFromDeals(
    [
      deal(1, "2025-10-07"), // 366 days ago: out
      deal(2, "2025-10-08"), // 365 days ago: in
      deal(3, "2026-10-08"), // today: in
      deal(4, "2026-10-09"), // tomorrow: out, no future events
      deal(5, "2026-09-01", { stage: "Booked Paid" }),
      deal(6, "2026-09-02", { stage: "Booked Unpaid" }),
      deal(7, "2026-09-03", { stage: "Closed Lost" }),
      deal(8, "2026-09-04", { stage: "Sent Quote" }),
      deal(9, null as unknown as string),
      deal(10, "not a date"),
    ],
    TODAY,
  );
  assert.deepEqual(events.map((e) => e.id), [3, 6, 5, 2]);
});

test("cateringEventsFromDeals: several events on one day sort by start time, latest first", () => {
  const events = cateringEventsFromDeals(
    [deal(1, "2026-10-01", { event_start_time: "09:00" }), deal(2, "2026-10-01", { event_start_time: "18:30" }), deal(3, "2026-10-01", { event_start_time: null })],
    TODAY,
  );
  assert.deepEqual(events.map((e) => e.id), [2, 1, 3]);
});

test("eventLabel: date, start time, venue/company and address; never the deal id", () => {
  const [e] = cateringEventsFromDeals([deal(4321, "2026-10-03", { company: "Acme", venue_name: "Houston Hall", venue_address: "3417 Spruce St" })], TODAY);
  const label = eventLabel(e);
  assert.equal(label, "Sat Oct 3, 2026, 2:00 PM, Acme at Houston Hall, 3417 Spruce St");
  assert.doesNotMatch(label, /4321/);
});

test("eventLabel: venue or company alone, and a missing time or address, still read cleanly", () => {
  const [a] = cateringEventsFromDeals([deal(1, "2026-10-03", { company: null, venue_name: "Houston Hall", event_start_time: null })], TODAY);
  assert.equal(eventLabel(a), "Sat Oct 3, 2026, Houston Hall, 1 Walnut St, Philadelphia, PA");
  const [b] = cateringEventsFromDeals([deal(2, "2026-10-03", { company: "Acme", venue_name: "acme", venue_address: null })], TODAY);
  assert.equal(eventLabel(b), "Sat Oct 3, 2026, 2:00 PM, Acme");
});

test("searchEvents: by venue, company or address, any case; blank finds everything", () => {
  const events: CateringEvent[] = cateringEventsFromDeals(
    [
      deal(1, "2026-10-01", { company: "Burlington Coat", venue_name: "HQ", venue_address: "1830 Route 130, Burlington NJ" }),
      deal(2, "2026-10-02", { company: "Penn Medicine", venue_name: "Blockley Hall", venue_address: "423 Guardian Dr" }),
    ],
    TODAY,
  );
  assert.deepEqual(searchEvents(events, "burl").map((e) => e.id), [1]);
  assert.deepEqual(searchEvents(events, "BLOCKLEY").map((e) => e.id), [2]);
  assert.deepEqual(searchEvents(events, "guardian").map((e) => e.id), [2]);
  assert.deepEqual(searchEvents(events, "  ").map((e) => e.id), [2, 1]);
  assert.deepEqual(searchEvents(events, "nowhere"), []);
});

test("reasonLabel: Groceries / errands with its note, or the Catering Event's label", () => {
  assert.equal(reasonLabel({ reason_kind: "errands", reason_note: "Restaurant Depot, cones", event_label: null }), "Groceries / errands: Restaurant Depot, cones");
  assert.equal(reasonLabel({ reason_kind: "catering_event", reason_note: null, event_label: "Sat Oct 3, 2026, Acme" }), "Catering Event: Sat Oct 3, 2026, Acme");
});

test("alsoOnSameEvent: other live reimbursements on the same Catering Event, with name and miles", () => {
  const items = [
    { id: 1, deal_id: 50, status: "submitted", full_name: "Donte", miles: 12.3 },
    { id: 2, deal_id: 50, status: "approved", full_name: "Sam", miles: 12.1 },
    { id: 3, deal_id: 50, status: "rejected", full_name: "Lee", miles: 30 },
    { id: 4, deal_id: 51, status: "submitted", full_name: "Kim", miles: 4 },
    { id: 5, deal_id: null, status: "submitted", full_name: "Ana", miles: 2 },
  ];
  const also = alsoOnSameEvent(items);
  assert.deepEqual(also.get(1), [{ full_name: "Sam", miles: 12.1 }]);
  assert.deepEqual(also.get(2), [{ full_name: "Donte", miles: 12.3 }]);
  assert.equal(also.get(4), undefined);
  assert.equal(also.get(5), undefined);
  assert.equal(also.get(3), undefined, "a Rejected one is not live and gets no note");
});
