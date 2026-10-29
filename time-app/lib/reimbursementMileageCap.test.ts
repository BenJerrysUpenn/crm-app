// What staff and Approvers read about a Catering Event's mileage cap (the
// owner, 2026-10-29; migration 49): the form's estimate and a reimbursement's
// detail line say the rate is what the event's quote charged a mile when that
// is below the IRS rate, and the IRS rate otherwise.
//
// Rendered with react-dom/server; the form's effects (the event list fetch)
// never run on the server.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadAppModule } from "./testing/fakeSupabase.ts";
import type { MileageCap, MileageRate } from "./reimbursements/money.ts";
import type { WithAmounts } from "./reimbursements/server.ts";

const { default: ReimbursementForm } = await loadAppModule<{ default: (props: unknown) => unknown }>(
  "components/reimbursements/ReimbursementForm.tsx",
);
const { ReimbursementDetail } = await loadAppModule<{ ReimbursementDetail: (props: unknown) => unknown }>(
  "components/reimbursements/shared.tsx",
);

const RATES: MileageRate[] = [{ starts_on: "2026-07-01", cents_per_mile: 76 }];

/** A typed 10 mi trip on 2026-10-07 for Catering Event 501, as loadMine hands it to the page. */
function trip(cap: MileageCap | null, amounts: { rate: number; capped: boolean; mileage_cents: number }): WithAmounts {
  return {
    id: 1, profile_id: "p", reason_kind: "catering_event", deal_id: 501, event_label: "Oct 7, Acme at Houston Hall", event_date: "2026-10-07",
    reason_note: null, trip_date: "2026-10-07", mileage_mode: "typed", miles: 10, stops: null, start_at_store: null, end_at_store: null,
    route_legs: null, tolls_cents: 0, parking_cents: 0, mileage_cents_override: null, receipt_paths: [], no_receipt_confirmed: true,
    status: "rejected", rejection_reason: "Which event?", decided_by: null, decided_at: null, paid_on: null, paid_by: null,
    receipts_emailed_at: null, submitted_at: "2026-10-08T00:00:00Z", created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z",
    mileage_cap: cap,
    amounts: { ...amounts, tolls_cents: 0, parking_cents: 0, total_cents: amounts.mileage_cents },
    adjustments: [],
    before_adjustments: null,
  } as unknown as WithAmounts;
}

function form(editing: WithAmounts): string {
  return renderToStaticMarkup(createElement(ReimbursementForm as never, { rates: RATES, today: "2026-10-29", editing, onDone: () => {}, onCancel: () => {} }));
}

function detail(r: WithAmounts): string {
  return renderToStaticMarkup(createElement(ReimbursementDetail as never, { r, fileHref: (p: string) => p }));
}

test("form: fixing a Catering Event trip estimates it at what the quote charged a mile, not the IRS rate", () => {
  const html = form(trip({ cap_cents_per_mile: 72.5, basis: "quoted_rate" }, { rate: 72.5, capped: true, mileage_cents: 725 }));
  // 10 mi at 72.5c = $7.25; at the IRS 76c it would be $7.60.
  assert.match(html, /Amount: \$7\.25 \(Mileage at 72\.5¢\/mi, what the Catering Event&#x27;s quote charged per mile/);
});

test("form: a Catering Event with no cap (no quote, the Uber flat fee) is estimated at the IRS rate", () => {
  const html = form(trip({ cap_cents_per_mile: null, basis: "no_quote" }, { rate: 76, capped: false, mileage_cents: 760 }));
  assert.match(html, /Amount: \$7\.60 \(Mileage at 76¢\/mi, the IRS rate for the trip date\)/);
});

test("detail: a capped trip's mileage line says the rate is the event's quoted one", () => {
  const capped = detail(trip({ cap_cents_per_mile: 72.5, basis: "quoted_rate" }, { rate: 72.5, capped: true, mileage_cents: 725 }));
  assert.match(capped, /72\.5¢\/mi \(the event&#x27;s quoted rate\) = \$7\.25/);
  const irs = detail(trip({ cap_cents_per_mile: null, basis: "no_quote" }, { rate: 76, capped: false, mileage_cents: 760 }));
  assert.doesNotMatch(irs, /quoted rate/);
  assert.match(irs, /76¢\/mi = \$7\.60/);
});
