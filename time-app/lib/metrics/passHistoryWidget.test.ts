// The Bookkeeping passes card (bj-finance #937, migration 56) as the Metrics
// page draws it: the board rendered to HTML with one saved view holding the
// card. Pins the tiles (the last bookkeeping pass, what it booked, the bank
// lines still waiting) over 30 or 90 days, that a run with no figure reads
// "–", never $0, the table of every run that "Show numbers" opens (pressed in
// a happy-dom board), and the states before there is anything to draw.
// Invented figures; crm-app is public.
//
//   npm test

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Window } from "happy-dom";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import { cleanWidgets } from "./views.ts";
import type { MetricsData, PassRunsData } from "./load.ts";
import { parsePassRun, type PassRun } from "./passHistory.ts";

// A browser for the test that presses "Show numbers". Set before react-dom
// loads: it decides at load time whether there is a DOM.
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
const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");

after(async () => {
  await browser.happyDOM.close();
});

const { default: MetricsBoard } = await loadAppModule<{ default: (p: Record<string, unknown>) => React.ReactElement }>(
  "components/metrics/MetricsBoard.tsx",
);
const { RunsTable } = await loadAppModule<{ RunsTable: (p: { runs: PassRun[]; title: string }) => React.ReactElement }>(
  "components/metrics/PassHistoryWidget.tsx",
);

const run = (over: Record<string, unknown>): PassRun =>
  parsePassRun({
    run_date: "2030-11-04", pass_code: "DAILY-02", run_label: "", attended: false, posted_count: 3, posted_dollars: 1200.5,
    queue_before: 12, queue_after: 9, cash: null, issues_filed: [], note: "", source: "pass", ...over,
  })!;

const RUNS: PassRun[] = [
  run({ run_date: "2030-09-01", posted_dollars: 99999, note: "outside the period" }),
  run({ run_date: "2030-11-01", posted_count: 2, posted_dollars: 300, queue_before: 8, queue_after: 6, issues_filed: [101] }),
  run({ run_date: "2030-11-03", pass_code: "WEEKLY-02", posted_count: null, posted_dollars: null, queue_before: null, queue_after: null, note: "sales report sent" }),
  run({ run_date: "2030-11-04", posted_count: 3, posted_dollars: 1200.5, queue_before: 12, queue_after: 9, issues_filed: [101, 102], note: "3 booked" }),
];

function metricsData(passRuns: PassRunsData): MetricsData {
  return {
    today: "2030-11-05", targets: [], catering: null, ar: null, labour: null, forward: null, leads: null, outreach: null, quotes: null,
    laborTarget: null, laborPlanning: null, feed: { status: "not_enabled" }, passRuns, problems: [],
  } as MetricsData;
}

function render(passRuns: PassRunsData, period = "30d"): string {
  const view = { id: "v1", name: "Finance", position: 0, widgets: cleanWidgets([{ id: "w1", metric: "pass_history", settings: { period } }]) };
  return renderToStaticMarkup(
    React.createElement(MetricsBoard, { data: metricsData(passRuns), initial: { mode: "server", views: [view], activeId: "v1" }, userId: "u1" }),
  );
}

/** The board in a DOM, views kept in this browser, with the card's first "Show numbers" pressed; returns the table's text. */
async function shownNumbers(runs: PassRun[]): Promise<string> {
  browser.localStorage.setItem(
    "withers-metrics-views:v1:u1",
    JSON.stringify({ views: [{ id: "v1", name: "Finance", position: 0, widgets: [{ id: "w1", metric: "pass_history", settings: { period: "30d" } }] }], activeId: "v1" }),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(React.createElement(MetricsBoard, { data: metricsData({ status: "ok", runs }), initial: { mode: "local" }, userId: "u1" })));
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Show numbers");
    assert.ok(button, "the card offers Show numbers");
    await act(async () => {
      button.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }) as never);
    });
    const table = container.querySelector("table");
    assert.ok(table, "Show numbers opens the table");
    return text(table.outerHTML);
  } finally {
    await act(() => root.unmount());
    container.remove();
    browser.localStorage.clear();
  }
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ");

test("the tiles show the last bookkeeping pass, what it booked, what still waits, and the period's total", () => {
  const t = text(render({ status: "ok", runs: RUNS }));
  assert.match(t, /Bookkeeping passes/);
  assert.match(t, /Last bookkeeping pass Nov 4 scheduled/);
  assert.match(t, /Booked that day \$1,200\.50 3 bank lines/);
  assert.match(t, /Bank lines waiting now 9 in QBO's For Review list/);
  assert.match(t, /Booked, last 30 days \$1,500\.50 2 issues filed/);
  assert.match(t, /Dollars booked each day/);
  assert.match(t, /Bank lines waiting for review/);
  assert.match(t, /Show numbers/);
  assert.doesNotMatch(t, /99,999/);
});

test("the tiles read the bookkeeping pass, not a later run of another pass", () => {
  const t = text(render({ status: "ok", runs: [...RUNS, run({ run_date: "2030-11-05", pass_code: "DAILY-03", posted_count: null, posted_dollars: null, queue_after: 40, cash: 812.4 })] }));
  assert.match(t, /Last bookkeeping pass Nov 4 scheduled/);
  assert.match(t, /Bank lines waiting now 9 /);
});

test("set to 90 days, the card reaches back 90 days", () => {
  const t = text(render({ status: "ok", runs: RUNS }, "90d"));
  assert.match(t, /Booked, last 90 days \$101,499\.50 2 issues filed/);
});

test("a bookkeeping pass that gave no dollar figure reads –, never $0", () => {
  const t = text(render({ status: "ok", runs: [run({ run_date: "2030-11-04", posted_dollars: null, posted_count: null, queue_after: null })] }));
  assert.match(t, /Booked that day – /);
  assert.match(t, /Bank lines waiting now – /);
  assert.doesNotMatch(t, /Booked that day \$0/);
});

test("behind Show numbers: every run of every pass in the period, newest first, in plain words", async () => {
  // Handed over oldest first and out of order; the card puts them newest first.
  const rows = await shownNumbers([RUNS[1], RUNS[3], RUNS[0], RUNS[2]]);
  assert.match(rows, /Day Pass Booked Waiting, before → after Cash Issues Note/);
  assert.match(
    rows,
    /Nov 4 Bookkeeping scheduled 3 · \$1,200\.50 12 → 9 – #101, #102 3 booked Nov 3 Sales report scheduled – – – – sales report sent Nov 1 Bookkeeping scheduled 2 · \$300\.00 8 → 6 – #101 –/,
  );
  assert.doesNotMatch(rows, /Sep 1|outside the period/);
});

test("a second sitting and a pass the card has no name for read in plain words", () => {
  const sitting = text(renderToStaticMarkup(React.createElement(RunsTable, {
    runs: [run({ attended: true, run_label: "evening", pass_code: "DAILY-03", cash: 812.4, queue_before: null, queue_after: 3 })],
    title: "runs",
  })));
  assert.match(sitting, /Cash total with someone, evening/);
  assert.match(sitting, /– → 3 \$812\.40/);
  const other = text(renderToStaticMarkup(React.createElement(RunsTable, { runs: [run({ pass_code: "MONTHLY-02" })], title: "runs" })));
  assert.match(other, /MONTHLY-02 scheduled/);
});

test("before migration 56, with no runs in the period, and when the read fails, the card says so", () => {
  assert.match(text(render({ status: "not_enabled" })), /The pass history is not set up yet\./);
  assert.match(text(render({ status: "ok", runs: [run({ run_date: "2030-09-01" })] })), /No pass has run in the last 30 days\./);
  assert.match(text(render({ status: "unreadable", message: "boom" })), /Could not load the pass history\./);
});
