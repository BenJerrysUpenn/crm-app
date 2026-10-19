// The Labor vs target card (bj-finance #696) as the Metrics page draws it:
// the board rendered to HTML with one saved view holding the card. Pins the
// month picker (the chosen month, else the last full month), the chart with
// its totals over complete weeks, the table behind "Show numbers", and that a
// week without its numbers reads n/a with the reason, never $0. Invented
// figures; crm-app is public.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type { LaborTargetMonth, LaborTargetWeek } from "./laborTarget.ts";
import type { MetricsData } from "./load.ts";
import type { WidgetSettings } from "./widgets.ts";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");

const { default: MetricsBoard } = await loadAppModule<{ default: (p: Record<string, unknown>) => React.ReactElement }>(
  "components/metrics/MetricsBoard.tsx",
);
const { LaborTargetTable } = await loadAppModule<{ LaborTargetTable: (p: { weeks: LaborTargetWeek[]; month: string }) => React.ReactElement }>(
  "components/metrics/widgets.tsx",
);

const pct = (v: number | null) => ({ value: v, needs: v == null ? ["Total payroll target"] : [] });

function wk(start: string, end: string, over: Partial<LaborTargetWeek> = {}): LaborTargetWeek {
  return {
    start, end, available: true, why: [], sales: 4_800, hours: 70, wages: 1_050, premium: 42, solo: 28, cateringHours: 0, cateringOffset: 0,
    taxesWc: 280, actual: 1_400, actualPct: 1_400 / 4_800, allInGoalPct: pct(0.25), targetPct: pct(0.25), targetDollars: 1_200, varianceDollars: 200, varianceHours: 10, ...over,
  };
}

const MONTHS: LaborTargetMonth[] = [
  { month: "2030-11", weeks: [wk("2030-11-03", "2030-11-09", { available: false, why: ["the week is not over yet"], sales: null, actual: null, actualPct: null, targetDollars: null, varianceDollars: null, varianceHours: null })] },
  {
    month: "2030-10",
    weeks: [
      wk("2030-10-06", "2030-10-12"),
      wk("2030-10-13", "2030-10-19", { varianceDollars: -40, varianceHours: -2, cateringHours: 10, cateringOffset: 312.5 }),
      wk("2030-10-27", "2030-11-02", {
        available: false, why: ["hourly payroll on file for 5 of 7 days"], hours: null, wages: null, premium: null, solo: null, taxesWc: null,
        actual: null, actualPct: null, varianceDollars: null, varianceHours: null,
      }),
    ],
  },
  { month: "2030-09", weeks: [wk("2030-09-01", "2030-09-07", { sales: 9_999 })] },
];

function render(settings: Partial<WidgetSettings>, laborTarget: MetricsData["laborTarget"] = { months: MONTHS, defaultMonth: "2030-10" }): string {
  const data = {
    today: "2030-11-05", targets: [], catering: null, ar: null, labour: null, forward: null, leads: null, outreach: null, quotes: null,
    laborTarget, feed: { status: "not_enabled" }, problems: [],
  } as MetricsData;
  const view = { id: "v1", name: "Labor", position: 0, widgets: [{ id: "w1", metric: "labor_vs_target", settings: { period: "mtd", ...settings } }] };
  return renderToStaticMarkup(React.createElement(MetricsBoard, { data, initial: { mode: "server", views: [view], activeId: "v1" }, userId: "u1" }));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ");

const table = (month: LaborTargetMonth) => text(renderToStaticMarkup(React.createElement(LaborTargetTable, { weeks: month.weeks, month: month.month })));

test("unset, the card shows the last full month, and the picker offers each month on file", () => {
  const html = render({});
  assert.match(html, /<select id="month-w1"[^>]*>/);
  assert.match(html, /<option value="2030-10" selected="">Oct 2030<\/option>/);
  assert.deepEqual([...html.matchAll(/<option value="(2030-\d\d)"/g)].map((m) => m[1]), ["2030-11", "2030-10", "2030-09"]);
});

test("the card is a chart of actual % against the target line, over-target weeks keyed, the table behind Show numbers", () => {
  const html = render({});
  const t = text(html);
  assert.match(html, /<canvas[^>]*role="img"[^>]*aria-label="Hourly labor all-in as a share of in-store sales, each week of Oct 2030/);
  assert.match(t, /Actual % Target %, all-in Over target/);
  assert.match(html, /aria-expanded="false"[^>]*aria-label="Show numbers: Hourly labor all-in/);
  // The table is not drawn until asked for.
  assert.doesNotMatch(t, /Week Sales Hourly labor, all-in/);
});

test("the totals count complete weeks only and say how many", () => {
  const t = text(render({}));
  // Two complete weeks: ($1,400 + $1,400) / ($4,800 + $4,800); variance +$200 − $40.
  assert.match(t, /Actual %, complete weeks 29\.2% 2 of 3 weeks complete/);
  assert.match(t, /Target %, all-in 25\.0% same weeks, by sales/);
  assert.match(t, /Over target \+\$160/);
  assert.match(t, /Variance hours \+8 h/);
});

test("a month with no complete week says so instead of a chart, and keeps its reasons", () => {
  const html = render({ month: "2030-11" });
  const t = text(html);
  assert.match(t, /No week of Nov 2030 has its numbers yet \(0 of 1 week complete\)\./);
  assert.doesNotMatch(html, /<canvas/);
  assert.doesNotMatch(t, /Actual %, complete weeks/);
  assert.match(t, /Nov 3–9: the week is not over yet\./);
  assert.match(t, /Show numbers/);
});

test("the table behind Show numbers is the week-by-week table, unchanged", () => {
  const t = table(MONTHS[1]);
  assert.match(t, /Week Sales Hourly labor, all-in Actual % Target %, all-in Variance \$ Variance hours/);
  assert.match(t, /Oct 6–12 \$4,800 \$1,400 29\.2% 25\.0% \+\$200 \+10 h/);
  assert.match(t, /Oct 13–19 \$4,800 \$1,400 29\.2% 25\.0% −\$40 −2 h/);
});

test("a week without its payroll reads n/a with the reason, never $0", () => {
  assert.match(table(MONTHS[1]), /Oct 27–Nov 2 \$4,800 n\/a n\/a 25\.0% n\/a n\/a/);
  const t = text(render({}));
  assert.match(t, /Oct 27–Nov 2: hourly payroll on file for 5 of 7 days\./);
  assert.doesNotMatch(t, /\$0\b/);
});

test("a chosen month is shown; one no longer on offer falls back to the last full month", () => {
  assert.match(render({ month: "2030-09" }), /each week of Sep 2030/);
  assert.match(render({ month: "2030-09" }), /<option value="2030-09" selected="">/);
  assert.match(render({ month: "2029-01" }), /each week of Oct 2030/);
});

test("when its reads fail the card says it could not load, with no picker", () => {
  const html = render({}, null);
  assert.match(text(html), /Could not load hourly payroll, daily sales or the control board\./);
  assert.doesNotMatch(html, /id="month-w1"/);
});

test("both sides read all-in, and a week with catering names the crew hours and $ taken off", () => {
  const t = text(render({}));
  assert.match(t, /Oct 13–19: catering crew billed to clients, 10 h and \$313 all-in, taken off hourly labor\./);
  assert.doesNotMatch(t, /Oct 6–12: catering crew/);
  assert.match(t, /all-in hourly goal/);
  assert.match(t, /25\.0% of sales this month/);
});
