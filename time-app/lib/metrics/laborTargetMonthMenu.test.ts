// The Labor vs target card's month menu (bj-finance #696), driven the way a
// manager drives it: the Metrics board rendered into a DOM (happy-dom), a
// month chosen from the menu, then "Custom". Pins that choosing a month sets
// the card's weeks to that month's, that "Custom" leaves the weeks as they
// are, and that the menu follows a week picked by hand. Views are kept in
// this browser (local mode), so no server is involved. Invented dates; every
// week lacks its numbers, so no chart is drawn.
//
//   npm test

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Window } from "happy-dom";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type { LaborTargetWeek } from "./laborTarget.ts";
import type { MetricsData } from "./load.ts";

// A browser for React to render into. Set before react-dom loads: it decides
// at load time whether there is a DOM.
const browser = new Window({ url: "http://time.localhost/metrics" });
for (const key of ["window", "self", "document", "navigator", "localStorage", "Node", "HTMLElement", "HTMLIFrameElement", "Event", "getComputedStyle", "MutationObserver"]) {
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

const { default: MetricsBoard } = await loadAppModule<{ default: (p: Record<string, unknown>) => React.ReactElement }>(
  "components/metrics/MetricsBoard.tsx",
);

after(async () => {
  await browser.happyDOM.close();
});

/** A week on offer whose numbers are not in yet: the card names it and draws no chart. */
function pending(start: string, end: string): LaborTargetWeek {
  return {
    start, end, available: false, why: ["the week is not over yet"], sales: null, hours: null, wages: null, premium: null, solo: null,
    cateringHours: null, cateringOffset: null, taxesWc: null, actual: null, actualPct: null,
    allInGoalPct: { value: 0.25, needs: [] }, targetPct: { value: 0.25, needs: [] }, targetDollars: null, varianceDollars: null, varianceHours: null,
  };
}

// Sep 1 to Sep 29 (Sep 2030's weeks), then Oct 6 to Oct 27 (Oct 2030's).
const WEEKS = ["2030-09-01", "2030-09-08", "2030-09-15", "2030-09-22", "2030-09-29", "2030-10-06", "2030-10-13", "2030-10-20", "2030-10-27"].map((s) => {
  const end = new Date(`${s}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return pending(s, end.toISOString().slice(0, 10));
});

const DATA = {
  today: "2030-11-02", targets: [], catering: null, ar: null, labour: null, forward: null, leads: null, outreach: null, quotes: null,
  laborTarget: { weeks: WEEKS, defaultRange: { from: "2030-10-06", to: "2030-10-27" } }, laborPlanning: null, feed: { status: "not_enabled" }, problems: [],
} as unknown as MetricsData;

async function mount() {
  // This browser's copy of the manager's views: one view holding the card, its range unset.
  browser.localStorage.setItem(
    "withers-metrics-views:v1:u1",
    JSON.stringify({ views: [{ id: "v1", name: "Labor", position: 0, widgets: [{ id: "w1", metric: "labor_vs_target", settings: { period: "mtd" } }] }], activeId: "v1" }),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(React.createElement(MetricsBoard, { data: DATA, initial: { mode: "local" }, userId: "u1" })));
  return {
    select: (id: string) => container.querySelector(`select#${id}`) as unknown as HTMLSelectElement,
    text: () => container.textContent ?? "",
    unmount: async () => {
      await act(() => root.unmount());
      container.remove();
      browser.localStorage.clear();
    },
  };
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new browser.Event("change", { bubbles: true }) as never);
  });
}

test("choosing a month from the menu sets the card to that month's weeks, and the menu shows it", async () => {
  const card = await mount();
  try {
    // Unset, the default range happens to be Oct's weeks.
    assert.equal(card.select("month-w1").value, "2030-10");
    await choose(card.select("month-w1"), "2030-09");
    assert.equal(card.select("from-w1").value, "2030-09-01");
    assert.equal(card.select("to-w1").value, "2030-09-29");
    assert.equal(card.select("month-w1").value, "2030-09");
    assert.match(card.text(), /No week of Sep 1 to Sep 29 has its numbers yet/);
    // The status line names the month the weeks are.
    assert.match(card.text(), /Labor vs target: Sep 2030, weeks of Sep 1 to Sep 29\./);
  } finally {
    await card.unmount();
  }
});

test("choosing Custom leaves the card's weeks as they are", async () => {
  const card = await mount();
  try {
    // From the default (Oct's weeks): still Oct's, not the first month's.
    await choose(card.select("month-w1"), "custom");
    assert.equal(card.select("from-w1").value, "2030-10-06");
    assert.equal(card.select("to-w1").value, "2030-10-27");
    // From a chosen month (Sep's weeks): still Sep's, not back to the default.
    await choose(card.select("month-w1"), "2030-09");
    await choose(card.select("month-w1"), "custom");
    assert.equal(card.select("from-w1").value, "2030-09-01");
    assert.equal(card.select("to-w1").value, "2030-09-29");
    // The weeks are still Sep's, so the menu still says so.
    assert.equal(card.select("month-w1").value, "2030-09");
  } finally {
    await card.unmount();
  }
});

test("a last week picked by hand that is not a month's end turns the menu to Custom", async () => {
  const card = await mount();
  try {
    await choose(card.select("month-w1"), "2030-09");
    await choose(card.select("to-w1"), "2030-10-06");
    assert.equal(card.select("from-w1").value, "2030-09-01");
    assert.equal(card.select("to-w1").value, "2030-10-06");
    assert.equal(card.select("month-w1").value, "custom");
    // No month is named for weeks that are not one month's (and never "Custom").
    assert.match(card.text(), /Labor vs target: weeks of Sep 1 to Oct 6\./);
  } finally {
    await card.unmount();
  }
});
