// The Labor Hours Planning card (bj-finance #742) as the Metrics page draws
// it: the board rendered to HTML with one saved view holding the card. Pins
// the weeks-ahead slider (saved count, else 26), the stacked chart with the
// coverage line, the table behind "Show numbers" naming filled and closed
// days, and that a week without its numbers reads n/a with the reason.
// Invented figures; crm-app is public.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import { addDays } from "./dates.ts";
import { cleanWidgets } from "./views.ts";
import type { LaborPlanning, PlanningWeek } from "./laborPlanning.ts";
import type { MetricsData } from "./load.ts";
import type { WidgetSettings } from "./widgets.ts";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");

const { default: MetricsBoard } = await loadAppModule<{ default: (p: Record<string, unknown>) => React.ReactElement }>(
  "components/metrics/MetricsBoard.tsx",
);
const { LaborPlanningTable } = await loadAppModule<{ LaborPlanningTable: (p: { weeks: PlanningWeek[] }) => React.ReactElement }>(
  "components/metrics/widgets.tsx",
);

const known = (value: number) => ({ value, needs: [] });

function wk(i: number, over: Partial<PlanningWeek> = {}): PlanningWeek {
  const start = addDays("2030-10-13", 7 * i);
  return {
    start, end: addDays(start, 6), days: [],
    inStoreHours: known(40), concessionHours: known(0), affordableHours: known(40), bookedHours: 5, estimatedHours: known(10),
    marketingBookedHours: 2, marketingEstimatedHours: known(3), coverageHours: known(77),
    projectedInStore: 3_000, concessionSales: 0, hourlyGoal: known(0.2), lastYearCatering: 15, lastYearMarketing: 5,
    filledDays: [], closedDays: [], events: [], notes: [], ...over,
  };
}

const WEEKS = Array.from({ length: 52 }, (_, i) =>
  i === 1
    ? wk(1, { filledDays: ["2029-10-24"], closedDays: ["2030-10-22"], events: ["Expo"], concessionSales: 1_000 })
    : i === 2
      ? wk(2, { estimatedHours: { value: null, needs: ["last year's catering hours for the week"] } })
      : i === 3
        ? wk(3, { marketingEstimatedHours: { value: null, needs: ["last year's marketing hours for the week"] } })
        : wk(i),
);
const PLANNING: LaborPlanning = {
  weeks: WEEKS, avgRate: known(15), avgRateOver: 2,
  trend: { lastMonth: { month: "2030-09-01", value: 11, source: "qbo", note: "QBO" }, sameMonthLastYear: { month: "2029-09-01", value: 10, source: "seller", note: "s" }, factor: known(1.1) },
};

function render(settings: Partial<WidgetSettings>, laborPlanning: LaborPlanning | null = PLANNING): string {
  const data = {
    today: "2030-10-16", targets: [], catering: null, ar: null, labour: null, forward: null, leads: null, outreach: null, quotes: null,
    laborTarget: null, laborPlanning, feed: { status: "not_enabled" }, problems: [],
  } as MetricsData;
  const view = { id: "v1", name: "Plan", position: 0, widgets: cleanWidgets([{ id: "w1", metric: "labor_hours_planning", settings: { period: "mtd", ...settings } }]) };
  return renderToStaticMarkup(React.createElement(MetricsBoard, { data, initial: { mode: "server", views: [view], activeId: "v1" }, userId: "u1" }));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ");

test("the slider shows 4 to 52 weeks ahead, 26 until one is saved, and the chart that many weeks", () => {
  const html = render({});
  assert.match(html, /<input id="weeks-w1" type="range" min="4" max="52" step="1"[^>]*value="26"/);
  assert.match(html, /aria-label="Target labor hours for the next 26 weeks/);
  assert.match(render({ weeks: 13 }), /aria-label="Target labor hours for the next 13 weeks/);
});

test("the chart stacks in-store, concessions, catering booked and estimated, marketing booked and estimated, under the coverage line", () => {
  const t = text(render({}));
  assert.match(
    t,
    /Affordable from in-store sales Affordable from concession sales Catering booked Catering estimated, not yet booked Marketing booked Marketing estimated, not yet booked Coverage \(store hours, one person\)/,
  );
  assert.match(t, /Show numbers/);
  assert.doesNotMatch(t, /Catering last year Notes/, "the table waits for Show numbers");
});

test("a week with a number not available says what it needs, never zero", () => {
  const t = text(render({}));
  assert.match(t, /Oct 27: needs last year's catering hours for the week/);
  assert.match(t, /Nov 3: needs last year's marketing hours for the week/);
});

test("Show numbers: each week's bands, total, coverage and what to know about it", () => {
  const t = text(renderToStaticMarkup(React.createElement(LaborPlanningTable, { weeks: WEEKS.slice(0, 4) })));
  assert.match(
    t,
    /Week In-store Concessions Catering booked Catering estimated Marketing booked Marketing estimated Target hours Coverage Projected in-store Concession sales Catering last year Marketing last year Notes/,
  );
  assert.match(t, /Oct 13–19 40 h 5 h 10 h 2 h 3 h 60 h 77 h \$3,000 15 h 5 h/);
  assert.match(t, /Oct 20–26 .* \$1,000 15 h 5 h Expo; closed Oct 22; filled: no sales on file for Oct 24, 2029/);
  assert.match(t, /Oct 27–Nov 2 40 h 5 h n\/a 2 h 3 h n\/a 77 h/);
  assert.match(t, /Nov 3–9 40 h 5 h 10 h 2 h n\/a n\/a 77 h/);
});

test("without its reads the card says it could not load, never an empty chart", () => {
  assert.match(text(render({}, null)), /Could not load the sales history, the control board, store hours or catering bookings/);
});
