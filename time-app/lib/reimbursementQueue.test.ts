// The Approver's queue on the Reimbursements tab of Withers Finance
// (bj-finance #210), driven the way an Approver drives it: rendered into a
// DOM (happy-dom) and its buttons clicked, fetch answered here. Pins the
// owner's rule of 2026-10-29: a Catering Event whose quote charged mileage
// but whose deal has no round-trip miles shows Approve disabled, with the
// reason the decide route gives, while the miles are recalculated
// automatically (and, when that failed, says a manager should check the venue
// address); a quote that charged no mileage (0c on purpose) is approved as
// usual. Invented people.
//
//   npm test

import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Window } from "happy-dom";

import { loadAppModule } from "./testing/fakeSupabase.ts";
import { reimbursementCents, type MileageCap, type MileageRate } from "./reimbursements/money.ts";
import type { QueueItem } from "./reimbursements/load.ts";

// A browser for React to render into. Set before react-dom loads: it decides
// at load time whether there is a DOM.
const browser = new Window({ url: "http://finance.localhost/payroll/reimbursements" });
for (const key of ["window", "self", "document", "navigator", "localStorage", "Node", "HTMLElement", "Event", "getComputedStyle", "MutationObserver"]) {
  Object.defineProperty(globalThis, key, {
    value: (browser as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
const { act } = React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> };
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime") as {
  AppRouterContext: React.Context<unknown>;
};

const { default: ReimbursementQueue } = await loadAppModule<{ default: (p: Record<string, unknown>) => React.ReactElement }>(
  "components/finance/ReimbursementQueue.tsx",
);

after(async () => {
  await browser.happyDOM.close();
});

const RATES: MileageRate[] = [{ starts_on: "2030-01-01", cents_per_mile: 76 }];
const NO_MILES: MileageCap = { cap_cents_per_mile: 0, basis: "no_miles_on_deal" };
const WALKABLE: MileageCap = { cap_cents_per_mile: 0, basis: "no_rate_on_quote" };
const REFUSED =
  "Its Catering Event's quote charged mileage, but the deal has no round-trip miles, so its miles pay 0¢. They are being recalculated automatically; once they are in, approve it.";
const REFUSED_FAILED =
  "Its Catering Event's quote charged mileage, but the deal has no round-trip miles, so its miles pay 0¢. The automatic recalculation did not find them, so a manager should check the venue address on the deal; once the miles are in, approve it.";

/** One queue item on a Catering Event under `cap`, priced as the server prices it. */
function item(cap: MileageCap | null, over: Partial<QueueItem> = {}): QueueItem {
  const r = {
    id: 1, profile_id: "p-staff", reason_kind: "catering_event", deal_id: 501, event_label: "Sat Oct 5, 2030, 2:00 PM, Test Co", event_date: "2030-10-05",
    reason_note: null, trip_date: "2030-10-05", mileage_mode: "typed", miles: 10, stops: null, start_at_store: null, end_at_store: null,
    route_legs: null, tolls_cents: 450, parking_cents: 800, mileage_cents_override: null, receipt_paths: [], no_receipt_confirmed: true,
    status: "submitted", rejection_reason: null, decided_by: null, decided_at: null, paid_on: null, paid_by: null, receipts_emailed_at: null,
    submitted_at: "2030-10-06T00:00:00Z", created_at: "2030-10-06T00:00:00Z", updated_at: "2030-10-06T00:00:00Z",
    full_name: "Test Driver", owner: false, also: [], refused: null, adjustments: [], before_adjustments: null,
    ...over,
  } as Omit<QueueItem, "mileage_cap" | "amounts">;
  return { ...r, mileage_cap: cap, amounts: reimbursementCents({ ...r, cap_cents_per_mile: cap?.cap_cents_per_mile ?? null }, RATES) };
}

let sent: { url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  sent = [];
});

async function mount(props: { submitted?: QueueItem[]; approved?: QueueItem[]; viewerIsOwner?: boolean }) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ reimbursement: {} });
  }) as typeof fetch;
  const router = { refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      React.createElement(
        AppRouterContext.Provider,
        { value: router },
        React.createElement(ReimbursementQueue, { submitted: [], approved: [], decided: [], viewerIsOwner: false, ...props }),
      ),
    ),
  );
  const buttons = (name: string) => ([...container.querySelectorAll("button")] as unknown as HTMLButtonElement[]).filter((x) => x.textContent === name);
  const button = (name: string) => {
    const b = buttons(name)[0];
    assert.ok(b, `no ${name} button`);
    return b;
  };
  return {
    text: () => (container.textContent ?? "").replace(/\s+/g, " "),
    buttons,
    button,
    click: (name: string) => act(async () => button(name).click()),
    unmount: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

test("queue: no round-trip miles on the deal shows Approve disabled with the reason, and clicking it sends nothing", async () => {
  const q = await mount({ submitted: [item(NO_MILES)] });
  try {
    const approve = q.button("Approve");
    assert.equal(approve.disabled, true);
    assert.equal(approve.getAttribute("title"), REFUSED);
    assert.ok(q.text().includes(REFUSED), "the reason is on the card, not only in a tooltip");
    assert.ok(!q.text().includes("payroll pays it on the next pay table"), "a Submitted one is not told it is about to be paid");
    await q.click("Approve");
    assert.equal(sent.length, 0);
    // Reject and Adjust stay open.
    assert.equal(q.button("Reject").disabled, false);
    assert.equal(q.button("Adjust").disabled, false);
  } finally {
    await q.unmount();
  }
});

test("queue: when the deal's last miles recalculation did not find miles, Approve stays disabled and the card says a manager should check the venue address", async () => {
  const q = await mount({ submitted: [item({ ...NO_MILES, recalc_failed: true })] });
  try {
    const approve = q.button("Approve");
    assert.equal(approve.disabled, true);
    assert.equal(approve.getAttribute("title"), REFUSED_FAILED);
    assert.ok(q.text().includes(REFUSED_FAILED));
    assert.ok(!q.text().includes("They are being recalculated automatically"));
  } finally {
    await q.unmount();
  }
});

test("queue: a quote that charged no mileage is approved as usual", async () => {
  const q = await mount({ submitted: [item(WALKABLE)] });
  try {
    assert.equal(q.button("Approve").disabled, false);
    assert.ok(!q.text().includes("once they are in, approve it"));
    await q.click("Approve");
    assert.deepEqual(sent, [{ url: "/api/payroll/reimbursements/1/decide", body: { action: "approve" } }]);
  } finally {
    await q.unmount();
  }
});

test("queue: with the deal's miles entered, or the Mileage adjusted, Approve is open", async () => {
  const q = await mount({
    submitted: [item({ cap_cents_per_mile: 72, basis: "quote_derived" }), item(NO_MILES, { id: 2, mileage_cents_override: 650 })],
  });
  try {
    assert.deepEqual(q.buttons("Approve").map((b) => b.disabled), [false, false]);
    assert.equal(q.text().includes("once they are in, approve it"), false, "no refusal; the detail may still say why the miles price at 0c");
  } finally {
    await q.unmount();
  }
});

test("queue: no Mileage rate for the trip date also shows Approve disabled with its reason (ruling 42)", async () => {
  const q = await mount({ submitted: [item(null, { trip_date: "2029-06-01" })] });
  try {
    assert.equal(q.button("Approve").disabled, true);
    assert.ok(q.text().includes("There is no Mileage rate for 2029-06-01"));
  } finally {
    await q.unmount();
  }
});

test("queue: an Approved one whose deal has no round-trip miles says so; an owner's offers Paid outside payroll disabled", async () => {
  const q = await mount({
    approved: [item(NO_MILES, { status: "approved" }), item(NO_MILES, { id: 2, status: "approved", owner: true })],
    viewerIsOwner: true,
  });
  try {
    assert.ok(q.text().includes("They are being recalculated automatically; once they are in, payroll pays it on the next pay table."));
    assert.ok(q.text().includes("They are being recalculated automatically; once they are in, mark it Paid outside payroll."));
    const paid = q.button("Paid outside payroll");
    assert.equal(paid.disabled, true);
    await q.click("Paid outside payroll");
    assert.equal(sent.length, 0);
  } finally {
    await q.unmount();
  }
});
