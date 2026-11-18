// The Labour, Weekly LER and Last closed month cards as the Metrics page
// draws them (rulings by Alina, 2026-11-18): the board rendered to HTML with
// one saved view holding the card, and, for the "Include owner pay" switch,
// the board in a happy-dom page with the switch pressed. Pins
//   * Labour: Sunday-to-Saturday weeks, in-store / catering / marketing hours
//     by the shift's work, sales per scooper-hour on Labor vs target's
//     in-store + delivery sales for the same week, no Labour % chart;
//   * Weekly LER: one line without owner pay, the switch adding $1,476 a week,
//     Labor vs target's sales and labor, the feed's trailing COGS %;
//   * Last closed month: LER on wages + employer tax, the switch adding
//     $6,396 a month.
// Invented figures; crm-app is public.
//
//   npm test

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Window } from "happy-dom";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import { cleanWidgets } from "./views.ts";
import { METRICS } from "./widgets.ts";
import { parseClosedMonth, parseDaily } from "./feed.ts";
import type { LaborTargetWeek } from "./laborTarget.ts";
import type { LabourWeek } from "./labour.ts";
import type { FeedData, MetricsData } from "./load.ts";

// A browser for the tests that press the switch. Set before react-dom loads:
// it decides at load time whether there is a DOM.
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

// Tuesday Nov 5 2030: the week of Sunday Nov 3 is in progress.
const TODAY = "2030-11-05";

const sat = (sun: string) => {
  const d = new Date(`${sun}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
};

/** A Labor vs target week: 5,500 of sales (4,500 in-store, 500 delivery, 500 catering), 2,000 of labor, 200 of marketing taken off. */
function ltWeek(start: string, over: Partial<LaborTargetWeek> = {}): LaborTargetWeek {
  return {
    start, end: sat(start), available: true, why: [], sales: 5_500, inStoreSales: 4_500, deliverySales: 500, cateringSales: 500,
    hours: 80, hourlyHours: 75, hourly: 1_500, salaried: 500, cateringHours: 5, cateringCost: 150, marketingHours: 5, marketingOffset: 200,
    actual: 2_000, actualPct: 2_000 / 5_500, goalPct: { value: 0.25, needs: [] }, targetPct: { value: 0.25, needs: [] }, targetDollars: 1_375,
    varianceDollars: 625, varianceHours: 31.25, ...over,
  };
}

const LT_WEEKS: LaborTargetWeek[] = [
  ltWeek("2030-10-13"),
  ltWeek("2030-10-20"), // the feed adds 500 of concessions on its Sunday
  ltWeek("2030-10-27", { inStoreSales: 4_000, deliverySales: 500, sales: 5_000 }),
  ltWeek("2030-11-03", { available: false, why: ["the week is not over yet"], sales: null, inStoreSales: null, deliverySales: null, cateringSales: null, actual: null }),
];

const DAILY = parseDaily({
  schema: 1, kind: "daily", as_of: "2030-11-04", cash: null,
  sales_by_day: [{ date: "2030-10-20", in_store: 1, delivery: 1, concessions: 500, basis: "booked" }],
  wages_by_week: [], cogs_pct_trailing: 0.25, cogs_basis: "invented", forward_cash: null,
})!;
const MONTH = parseClosedMonth({
  schema: 1, kind: "closed_month", month: "2030-09", status: "final",
  revenue: 41_234.56, revenue_by_stream: { in_store: 30_000, delivery: 1_500, catering: 9_000, concessions: 0, other: 734.56 },
  cogs: 9_100, gross_profit: 32_134.56, wages: 15_000, employer_tax: 1_300, pre_tax_profit: -1_760.16,
  rolling_12: { months: 12, revenue: 401_234, pre_tax_profit: -12_345, seller_months: 8 },
})!;
const FEED: FeedData = { status: "ok", builtAt: "2030-11-04T12:00:00Z", daily: DAILY, cashHistory: [], closedMonths: [MONTH] };

/** A Labour week by its Sunday. */
const lbWeek = (week: string, over: Partial<LabourWeek> = {}): LabourWeek => ({
  week, inStoreHours: 30, cateringHours: 4, marketingHours: 2, inStoreHourlyCost: 450, cateringHourlyCost: 60, marketingHourlyCost: 30,
  salariedHours: 10, noRateHours: 3, ...over,
});
const LABOUR = {
  weeks: [lbWeek("2030-10-13"), lbWeek("2030-10-20"), lbWeek("2030-10-27", { inStoreHours: 20, cateringHours: 5, marketingHours: 3 }), lbWeek("2030-11-03")],
  openPunches: 1,
};

function metricsData(over: Partial<MetricsData> = {}): MetricsData {
  return {
    today: TODAY, targets: [], catering: null, ar: null, labour: LABOUR, forward: null, leads: null, outreach: null, quotes: null,
    laborTarget: { weeks: LT_WEEKS, defaultRange: { from: "2030-10-13", to: "2030-10-27" } }, laborPlanning: null, feed: FEED,
    passRuns: { status: "not_enabled" }, problems: [], ...over,
  } as MetricsData;
}

function render(metric: string, period: string, over: Partial<MetricsData> = {}): string {
  const view = { id: "v1", name: "Labor", position: 0, widgets: cleanWidgets([{ id: "w1", metric, settings: { period } }]) };
  return renderToStaticMarkup(React.createElement(MetricsBoard, { data: metricsData(over), initial: { mode: "server", views: [view], activeId: "v1" }, userId: "u1" }));
}

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** The card in a DOM with its "Include owner pay" switch pressed; returns the page's text and HTML. */
async function withOwnerPay(metric: string, period: string): Promise<{ text: string; html: string; checked: boolean }> {
  browser.localStorage.setItem(
    "withers-metrics-views:v1:u1",
    JSON.stringify({ views: [{ id: "v1", name: "Labor", position: 0, widgets: [{ id: "w1", metric, settings: { period } }] }], activeId: "v1" }),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(React.createElement(MetricsBoard, { data: metricsData(), initial: { mode: "local" }, userId: "u1" })));
    const box = [...container.querySelectorAll("label")].find((l) => /Include owner pay/.test(l.textContent ?? ""))?.querySelector("input");
    assert.ok(box, "the card has an Include owner pay switch");
    assert.equal((box as unknown as HTMLInputElement).checked, false, "off by default: the owners are not paid");
    await act(async () => {
      (box as unknown as HTMLInputElement).click();
    });
    return { text: text(container.innerHTML), html: container.innerHTML, checked: (box as unknown as HTMLInputElement).checked };
  } finally {
    await act(() => root.unmount());
    container.remove();
    browser.localStorage.clear();
  }
}

// ---- Weekly LER ---------------------------------------------------------------------------

test("weekly LER: one line without owner pay, on Labor vs target's weeks, sales and labor", () => {
  const html = render("weekly_ler", "8w");
  const t = text(html);
  // The last week over is Oct 27 (Nov 3 is in progress): 5,000 x 0.75 / 2,200.
  assert.match(t, /LER, last full week 1\.70 week of Oct 27/);
  assert.match(t, /Sales that week \$5,000/);
  assert.match(t, /Gross profit \(estimate\) \$3,750 COGS 25\.0%/);
  assert.match(t, /Labor that week \$2,200 owner pay left out/);
  assert.match(html, /aria-label="Weekly LER, against the 2\.0 target/);
  assert.match(t, /Include owner pay \(\$1,476 a week\)/);
  assert.doesNotMatch(t, /LER paid|LER unpaid|paid and unpaid/);
});

test("weekly LER says owner pay is left out and how the switch adds it, and that its weeks and numbers are Labor vs target's", () => {
  const t = text(render("weekly_ler", "8w"));
  assert.match(t, /LER = gross profit \/ labor\. Owner pay is left out, since the owners are not paid; the switch adds it at \$1,476 a week/);
  assert.match(t, /Weeks run Sunday to Saturday, the same weeks as Labor vs target/);
  assert.match(t, /marketing work included/);
});

test("weekly LER with the switch on adds owner pay to the labor: tile, labor and chart", async () => {
  const { text: t, html, checked } = await withOwnerPay("weekly_ler", "8w");
  assert.equal(checked, true);
  // 3,750 / (2,200 + 1,476).
  assert.match(t, /LER, last full week 1\.02 week of Oct 27/);
  assert.match(t, /Labor that week \$3,676 owner pay included/);
  assert.match(html, /aria-label="Weekly LER with owner pay, against the 2\.0 target/);
});

test("weekly LER waits, saying for what, without Labor vs target or without the trailing COGS %", () => {
  assert.match(text(render("weekly_ler", "8w", { laborTarget: null })), /Weekly LER needs the Labor vs target numbers, which could not be read\./);
  assert.match(text(render("weekly_ler", "8w", { feed: { status: "not_enabled" } })), /The finance feed is not switched on yet\. Weekly LER needs it\./);
  const noCogs: FeedData = { ...FEED, daily: { ...DAILY, cogs_pct_trailing: null } };
  assert.match(text(render("weekly_ler", "8w", { feed: noCogs })), /The feed has not published the trailing COGS % yet\. Weekly LER needs it\./);
});

test("weekly LER of weeks Labor vs target cannot count reads –, never 0", () => {
  const na = LT_WEEKS.map((w) => ({ ...w, available: false, sales: null, actual: null }));
  const t = text(render("weekly_ler", "8w", { laborTarget: { weeks: na, defaultRange: { from: "2030-10-13", to: "2030-10-27" } } }));
  assert.match(t, /LER, last full week – /);
  assert.match(t, /Sales that week – /);
  assert.doesNotMatch(t, /\$0\b|NaN/);
});

// ---- Last closed month --------------------------------------------------------------------

test("last closed month: LER without owner pay on wages + employer tax, and the switch's monthly owner pay", () => {
  const html = render("closed_month", "6m");
  const t = text(html);
  assert.match(t, /LER 1\.97 target 2\.0/); // 32,134.56 / 16,300
  assert.match(html, /aria-label="Monthly LER, against the 2\.0 target/);
  assert.match(t, /Include owner pay \(\$6,396 a month\)/);
  assert.match(t, /Monthly labor is QBO's wages and payroll taxes for the month, by pay date\./);
  assert.doesNotMatch(t, /paid \/ unpaid|LER paid|LER unpaid/);
});

test("last closed month with the switch on: LER with owner pay", async () => {
  const { text: t, html } = await withOwnerPay("closed_month", "6m");
  assert.match(t, /LER, owner pay included 1\.42 target 2\.0/); // 32,134.56 / 22,696
  assert.match(html, /aria-label="Monthly LER with owner pay, against the 2\.0 target/);
});

// ---- Labour ---------------------------------------------------------------------------------

test("the labour card: Sunday weeks, catering and marketing hours together, hourly $ across all three kinds of work", () => {
  const html = render("labour", "4w");
  const t = text(html);
  assert.match(t, /In-store hours, last full week 20 h week of Oct 27/);
  assert.match(t, /Catering and marketing hours 8 h 5 h catering, 3 h marketing/);
  assert.match(t, /Hourly labour \$, last full week \$540 hourly staff only/);
  assert.match(html, /aria-label="Clocked hours by week: in-store, catering and marketing/);
  assert.match(t, /In-store Catering Marketing/);
});

test("sales per scooper-hour is Labor vs target's in-store + delivery for the same Sunday week, over in-store hours", () => {
  const t = text(render("labour", "4w"));
  // Oct 27: (4,000 + 500) / 20 h; catering sales are not a scooper's.
  assert.match(t, /Sales per scooper-hour \$225 last full week, in-store and delivery/);
  assert.match(t, /Sales per scooper-hour = in-store sales \(register and online pickup\) \+ delivery sales \/ in-store hours clocked/);
  // Without Labor vs target there is no figure, never 0.
  const none = text(render("labour", "4w", { laborTarget: null }));
  assert.match(none, /Sales per scooper-hour – last full week/);
  assert.doesNotMatch(none, /Waiting on the finance feed/);
});

test("the labour card has no Labour % chart, and says how a punch's work is decided", () => {
  const t = text(render("labour", "4w"));
  assert.doesNotMatch(t, /Labour %/);
  assert.match(t, /Weeks run Sunday to Saturday, as the schedule does/);
  assert.match(t, /A punch counts by its shift: a Marketing shift or any shift on a marketing deal is marketing; otherwise a Catering shift is catering; everything else is in-store\./);
  assert.match(t, /A punch with no shift is in-store, except the part that overlaps the same person's catering or marketing shift that has no punch of its own\./);
  assert.match(t, /1 punch still open and not counted\./);
});

// ---- The widget catalog -----------------------------------------------------------------------

test("the widget catalog, shown at the top of each card, describes it by the 2026-11-18 rulings, not the rules they replaced", () => {
  assert.doesNotMatch(METRICS.weekly_ler.blurb, /paid and unpaid/);
  assert.match(METRICS.weekly_ler.blurb, /owner pay/);
  assert.doesNotMatch(METRICS.closed_month.blurb, /paid and unpaid/);
  assert.doesNotMatch(METRICS.labour.title, /labour %/i);
  assert.match(METRICS.labour.blurb, /marketing/);
  assert.doesNotMatch(METRICS.labor_vs_target.blurb, /catering work left out|in-store sales|all-in target/);
  assert.match(METRICS.labor_vs_target.blurb, /payroll target/);
  assert.match(text(render("labour", "4w")), /Labour: hours and sales per scooper-hour Clocked hours by week, in-store, catering and marketing/);
});
