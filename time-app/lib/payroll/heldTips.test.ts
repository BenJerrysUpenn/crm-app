// Unit tests for the held catering-tip ledger (payroll spec §3.6).
//
//   npm test        (node --test — Node runs TypeScript directly)
//
// The fixture is the 2026-09-23 run's own shape: some tips paid before this
// ledger existed, some paid for events that have not happened yet, and the
// phantom $100 — one payment against deal 25188 written twice under two payer
// names (Geraci and Burlington).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findDuplicates,
  formatCents,
  reconcile,
  releasableForWindow,
  totalCents,
  type HeldTipRow,
} from "./heldTips.ts";

const WINDOW_END = "2026-09-20";

function row(over: Partial<HeldTipRow> & Pick<HeldTipRow, "tip_cents" | "paid_date" | "status">): HeldTipRow {
  return {
    deal_id: null,
    payer: null,
    event_date: null,
    released_in_run: null,
    ...over,
  };
}

const LEDGER: HeldTipRow[] = [
  // Paid before this ledger covered anything. Carried so the tie-out balances.
  row({ deal_id: 25100, payer: "PwC", tip_cents: 5000, paid_date: "2026-07-02", event_date: "2026-07-09", status: "pre_window" }),
  // Released in the 09-23 run: event inside the window.
  row({
    deal_id: 25188, payer: "Geraci", tip_cents: 10000, paid_date: "2026-08-28", event_date: "2026-09-09",
    status: "released", released_in_run: "2026-09-23",
  }),
  // Held: paid weeks early for an event after the window end.
  row({ deal_id: 25390, payer: "NAKASEC", tip_cents: 7500, paid_date: "2026-09-12", event_date: "2026-10-04", status: "held" }),
  // Held and releasable: the event happened on the window's last day.
  row({ deal_id: 25254, payer: "Terrain", tip_cents: 2500, paid_date: "2026-09-05", event_date: "2026-09-20", status: "held" }),
  // Held with no event date: §3.5's unprovable case. Never auto-released.
  row({ deal_id: 25256, payer: "Unknown", tip_cents: 1200, paid_date: "2026-09-18", status: "held" }),
];

test("3.6: the three statuses add up to what the ledger claims", () => {
  const totals = totalCents(LEDGER);
  assert.equal(totals.preWindowCents, 5000);
  assert.equal(totals.releasedCents, 10000);
  assert.equal(totals.heldCents, 7500 + 2500 + 1200);
  assert.equal(totals.ledgerCents, 26200);
});

test("3.6: released + held + pre_window == the all-history invoice-tip total", () => {
  const r = reconcile(LEDGER, 26200);
  assert.equal(r.balanced, true);
  assert.equal(r.differenceCents, 0);
});

test("3.6: the tie-out fails by the exact amount, with no tolerance", () => {
  // Both sides are integer cents summed from records. A one-cent difference is
  // a dropped row or a transposed amount, never rounding.
  const r = reconcile(LEDGER, 26199);
  assert.equal(r.balanced, false);
  assert.equal(r.differenceCents, 1);

  const phantom = reconcile([...LEDGER, row({ deal_id: 25188, payer: "Burlington", tip_cents: 10000, paid_date: "2026-08-28", event_date: "2026-09-09", status: "held" })], 26200);
  assert.equal(phantom.balanced, false);
  assert.equal(phantom.differenceCents, 10000); // the phantom $100, to the cent
});

test("3.6: the phantom $100 is found on deal, date and amount — not on the payer name", () => {
  // "Geraci" and "Burlington" were the same payment against deal 25188. The
  // names were the disguise, which is why payer is not part of the key.
  const withPhantom: HeldTipRow[] = [
    ...LEDGER,
    row({ deal_id: 25188, payer: "Burlington", tip_cents: 10000, paid_date: "2026-08-28", event_date: "2026-09-09", status: "held" }),
  ];
  const dupes = findDuplicates(withPhantom);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].reason, "same-deal-date-amount");
  assert.equal(dupes[0].excessCents, 10000);
  assert.deepEqual(dupes[0].rows.map((r) => r.payer), ["Geraci", "Burlington"]);
});

test("3.6: a clean ledger reports no duplicates", () => {
  assert.deepEqual(findDuplicates(LEDGER), []);
});

test("3.6: rows carrying different Square payment ids are two payments, however alike", () => {
  const twins: HeldTipRow[] = [
    row({ deal_id: 25300, payer: "Wharton", tip_cents: 4000, paid_date: "2026-09-15", status: "held", source_payment_id: "pay_A" }),
    row({ deal_id: 25300, payer: "Wharton", tip_cents: 4000, paid_date: "2026-09-15", status: "held", source_payment_id: "pay_B" }),
  ];
  assert.deepEqual(findDuplicates(twins), []);
});

test("3.6: the same Square payment id twice is a duplicate", () => {
  const same: HeldTipRow[] = [
    row({ deal_id: 25300, payer: "Wharton", tip_cents: 4000, paid_date: "2026-09-15", status: "held", source_payment_id: "pay_A" }),
    row({ deal_id: 25301, payer: "Wharton", tip_cents: 4000, paid_date: "2026-09-15", status: "held", source_payment_id: "pay_A" }),
  ];
  const dupes = findDuplicates(same);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].reason, "same-payment-id");
  assert.equal(dupes[0].excessCents, 4000);
});

test("3.4/3.6: a run releases by EVENT date, not by when the money arrived", () => {
  const { release, stillHeld, undated } = releasableForWindow(LEDGER, WINDOW_END);
  // Terrain: paid 09-05, event 09-20 — inside the window, so it releases.
  assert.deepEqual(release.map((r) => r.deal_id), [25254]);
  // NAKASEC: paid 09-12, event 10-04 — the money is here, the work is not.
  assert.deepEqual(stillHeld.map((r) => r.deal_id), [25390]);
  // No event date: reported, never guessed at (§3.5).
  assert.deepEqual(undated.map((r) => r.deal_id), [25256]);
});

test("3.6: released and pre_window rows are never picked up by a later run", () => {
  const { release, stillHeld, undated } = releasableForWindow(LEDGER, "2026-12-31");
  const touched = [...release, ...stillHeld, ...undated];
  assert.equal(touched.every((r) => r.status === "held"), true);
  assert.equal(touched.some((r) => r.deal_id === 25188), false); // already paid
  assert.equal(touched.some((r) => r.deal_id === 25100), false); // pre-window
});

test("cents render as money", () => {
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(7), "$0.07");
  assert.equal(formatCents(26200), "$262.00");
  assert.equal(formatCents(123456789), "$1,234,567.89");
  assert.equal(formatCents(-100), "-$1.00");
});
