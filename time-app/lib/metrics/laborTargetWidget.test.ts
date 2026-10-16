// The Labor vs target card (bj-finance #696) as the Metrics page draws it:
// the board rendered to HTML with one saved view holding the card. Pins the
// month picker (the chosen month, else the last full month) and that a week
// without its numbers reads n/a with the reason, never $0. Invented figures;
// crm-app is public.
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

const pct = (v: number | null) => ({ value: v, needs: v == null ? ["Total payroll target"] : [] });

function wk(start: string, end: string, over: Partial<LaborTargetWeek> = {}): LaborTargetWeek {
  return {
    start, end, available: true, why: [], sales: 4_800, hours: 70, wages: 1_050, premium: 42, solo: 28, taxesWc: 280, actual: 1_400,
    actualPct: 1_400 / 4_800, hourlyGoalPct: pct(0.2), targetPct: pct(0.25), targetDollars: 1_200, varianceDollars: 200, varianceHours: 10, ...over,
  };
}

const MONTHS: LaborTargetMonth[] = [
  { month: "2030-11", weeks: [wk("2030-11-03", "2030-11-09", { available: false, why: ["the week is not over yet"], sales: null, actual: null, actualPct: null, targetDollars: null, varianceDollars: null, varianceHours: null })] },
  {
    month: "2030-10",
    weeks: [
      wk("2030-10-06", "2030-10-12"),
      wk("2030-10-13", "2030-10-19", { varianceDollars: -40, varianceHours: -2 }),
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

test("unset, the card shows the last full month, and the picker offers each month on file", () => {
  const html = render({});
  assert.match(html, /<select id="month-w1"[^>]*>/);
  assert.match(html, /<option value="2030-10" selected="">Oct 2030<\/option>/);
  assert.deepEqual([...html.matchAll(/<option value="(2030-\d\d)"/g)].map((m) => m[1]), ["2030-11", "2030-10", "2030-09"]);
  const t = text(html);
  assert.match(t, /Week Sales Hourly labor Actual % Target % Variance \$ Variance hours/);
  assert.match(t, /Oct 6–12 \$4,800 \$1,400 29\.2% 25\.0% \+\$200 \+10 h/);
  assert.match(t, /Oct 13–19 \$4,800 \$1,400 29\.2% 25\.0% −\$40 −2 h/);
});

test("a week without its payroll reads n/a with the reason, never $0", () => {
  const t = text(render({}));
  assert.match(t, /Oct 27–Nov 2 \$4,800 n\/a n\/a 25\.0% n\/a n\/a/);
  assert.match(t, /Oct 27–Nov 2: hourly payroll on file for 5 of 7 days\./);
  assert.doesNotMatch(t, /\$0\b/);
});

test("a chosen month is shown; one no longer on offer falls back to the last full month", () => {
  assert.match(text(render({ month: "2030-09" })), /Sep 1–7 \$9,999/);
  assert.match(render({ month: "2030-09" }), /<option value="2030-09" selected="">/);
  assert.match(text(render({ month: "2029-01" })), /Oct 6–12/);
});

test("when its reads fail the card says it could not load, with no picker", () => {
  const html = render({}, null);
  assert.match(text(html), /Could not load hourly payroll, daily sales or the control board\./);
  assert.doesNotMatch(html, /id="month-w1"/);
});
