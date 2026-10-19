// The Labor vs target card (bj-finance #696) as the Metrics page draws it:
// the board rendered to HTML with one saved view holding the card. Pins the
// week range picker (the chosen range, else the default range; a view saved
// under the old month picker shows that month's weeks), the chart with
// its totals over complete weeks, the table behind "Show numbers", and that a
// week without its numbers reads n/a with the reason, never $0. Invented
// figures; crm-app is public.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type { LaborTargetWeek } from "./laborTarget.ts";
import type { WeekRange } from "./weekRange.ts";
import { cleanWidgets } from "./views.ts";
import type { MetricsData } from "./load.ts";
import type { WidgetSettings } from "./widgets.ts";

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");

const { default: MetricsBoard } = await loadAppModule<{ default: (p: Record<string, unknown>) => React.ReactElement }>(
  "components/metrics/MetricsBoard.tsx",
);
const { LaborTargetTable } = await loadAppModule<{ LaborTargetTable: (p: { weeks: LaborTargetWeek[]; range: WeekRange }) => React.ReactElement }>(
  "components/metrics/widgets.tsx",
);

const pct = (v: number | null) => ({ value: v, needs: v == null ? ["Total payroll target"] : [] });

function wk(start: string, end: string, over: Partial<LaborTargetWeek> = {}): LaborTargetWeek {
  return {
    start, end, available: true, why: [], sales: 4_800, hours: 70, wages: 1_050, premium: 42, solo: 28, cateringHours: 0, cateringOffset: 0,
    taxesWc: 280, actual: 1_400, actualPct: 1_400 / 4_800, allInGoalPct: pct(0.25), targetPct: pct(0.25), targetDollars: 1_200, varianceDollars: 200, varianceHours: 10, ...over,
  };
}

const PENDING = { available: false, why: ["the week is not over yet"], sales: null, actual: null, actualPct: null, targetDollars: null, varianceDollars: null, varianceHours: null };

/** Every week on offer, oldest first: Sep 1, then Sep 29 to Nov 3 (the first part of Sep left out to keep it short). */
const WEEKS: LaborTargetWeek[] = [
  wk("2030-09-01", "2030-09-07", { sales: 9_999 }),
  wk("2030-09-29", "2030-10-05", { sales: 6_000, actual: 1_500, actualPct: 0.25, targetDollars: 1_500, varianceDollars: 0, varianceHours: 0 }),
  wk("2030-10-06", "2030-10-12"),
  wk("2030-10-13", "2030-10-19", { varianceDollars: -40, varianceHours: -2, cateringHours: 10, cateringOffset: 312.5 }),
  wk("2030-10-20", "2030-10-26", { available: false, why: ["in-store sales on file for 6 of 7 days"], sales: null, actualPct: null, targetDollars: null, varianceDollars: null, varianceHours: null }),
  wk("2030-10-27", "2030-11-02", {
    available: false, why: ["hourly payroll on file for 5 of 7 days"], hours: null, wages: null, premium: null, solo: null, taxesWc: null,
    actual: null, actualPct: null, varianceDollars: null, varianceHours: null,
  }),
  wk("2030-11-03", "2030-11-09", PENDING),
];
const DEFAULT: WeekRange = { from: "2030-10-06", to: "2030-10-27" };

function render(settings: Partial<WidgetSettings> & { month?: string }, laborTarget: MetricsData["laborTarget"] = { weeks: WEEKS, defaultRange: DEFAULT }): string {
  const data = {
    today: "2030-11-05", targets: [], catering: null, ar: null, labour: null, forward: null, leads: null, outreach: null, quotes: null,
    laborTarget, feed: { status: "not_enabled" }, problems: [],
  } as MetricsData;
  // As the page loads a saved view: cleaned.
  const view = { id: "v1", name: "Labor", position: 0, widgets: cleanWidgets([{ id: "w1", metric: "labor_vs_target", settings: { period: "mtd", ...settings } }]) };
  return renderToStaticMarkup(React.createElement(MetricsBoard, { data, initial: { mode: "server", views: [view], activeId: "v1" }, userId: "u1" }));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ");

const table = (range: WeekRange) =>
  text(renderToStaticMarkup(React.createElement(LaborTargetTable, { weeks: WEEKS.filter((w) => w.start >= range.from && w.start <= range.to), range })));
const options = (html: string, id: string) => [...(html.match(new RegExp(`<select id="${id}"[^>]*>(.*?)</select>`))?.[1] ?? "").matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
const selected = (html: string, id: string) => html.match(new RegExp(`<select id="${id}"[^>]*>.*?<option value="([^"]+)" selected=""`))?.[1];

test("unset, the card shows the default range, and the picker offers every week on file at both ends", () => {
  const html = render({});
  assert.match(html, /<select id="from-w1"[^>]*>/);
  assert.match(html, /<select id="to-w1"[^>]*>/);
  assert.equal(selected(html, "from-w1"), "2030-10-06");
  assert.equal(selected(html, "to-w1"), "2030-10-27");
  const all = WEEKS.map((w) => w.start);
  assert.deepEqual(options(html, "from-w1"), all);
  assert.deepEqual(options(html, "to-w1"), all);
  // Each week is named by its Sunday.
  assert.match(html, /<option value="2030-09-29">Sep 29<\/option>/);
  assert.match(html, /aria-label="Weeks for Labor vs target"/);
});

test("the card is a chart of actual % against the target line, over-target weeks keyed, the table behind Show numbers", () => {
  const html = render({});
  const t = text(html);
  assert.match(html, /<canvas[^>]*role="img"[^>]*aria-label="Hourly labor all-in as a share of in-store sales, weeks of Oct 6 to Oct 27/);
  assert.match(t, /Actual % Target %, all-in Over target/);
  assert.match(html, /aria-expanded="false"[^>]*aria-label="Show numbers: Hourly labor all-in/);
  // The table is not drawn until asked for.
  assert.doesNotMatch(t, /Week Sales Hourly labor, all-in/);
});

test("the totals count complete weeks only and say how many", () => {
  const t = text(render({}));
  // Two complete weeks of four: ($1,400 + $1,400) / ($4,800 + $4,800); variance +$200 − $40.
  assert.match(t, /Actual %, complete weeks 29\.2% 2 of 4 weeks complete/);
  assert.match(t, /Target %, all-in 25\.0% same weeks, by sales/);
  assert.match(t, /Over target \+\$160/);
  assert.match(t, /Variance hours \+8 h/);
});

test("a range with no complete week says so instead of a chart, and keeps its reasons", () => {
  const html = render({ from: "2030-11-03", to: "2030-11-03" });
  const t = text(html);
  assert.match(t, /No week of Nov 3 has its numbers yet \(0 of 1 week complete\)\./);
  assert.doesNotMatch(html, /<canvas/);
  assert.doesNotMatch(t, /Actual %, complete weeks/);
  assert.match(t, /Nov 3: the week is not over yet/);
  assert.match(t, /Show numbers/);
});

test("a range across months covers every week in it: tiles and one muted n/a line per n/a week", () => {
  const html = render({ from: "2030-09-01", to: "2030-11-03" });
  const t = text(html);
  assert.match(html, /weeks of Sep 1 to Nov 3 by their Sunday/);
  // Four complete weeks: (1,400 + 1,500 + 1,400 + 1,400) / (9,999 + 6,000 + 4,800 + 4,800).
  assert.match(t, /Actual %, complete weeks 22\.3% 4 of 7 weeks complete/);
  assert.match(t, /Over target \+\$360/);
  assert.match(t, /Oct 20: in-store sales on file for 6 of 7 days/);
  assert.match(t, /Oct 27: hourly payroll on file for 5 of 7 days/);
  assert.match(t, /Nov 3: the week is not over yet/);
  // Catering is in the table now, not under the chart.
  assert.doesNotMatch(t, /catering crew billed to clients/);
});

test("the table behind Show numbers is the week-by-week table, with the catering crew taken off as a column", () => {
  const t = table(DEFAULT);
  assert.match(t, /Week Sales Hourly labor, all-in Actual % Target %, all-in Variance \$ Variance hours Catering crew taken off/);
  // No catering: the column is blank.
  assert.match(t, /Oct 6–12 \$4,800 \$1,400 29\.2% 25\.0% \+\$200 \+10 h Oct 13/);
  assert.match(t, /Oct 13–19 \$4,800 \$1,400 29\.2% 25\.0% −\$40 −2 h 10 h, \$313 all-in/);
});

test("the catering column stays blank for a week whose catering hours or $ are not on file", () => {
  const weeks = [
    wk("2030-10-06", "2030-10-12", { cateringHours: 10, cateringOffset: null }),
    wk("2030-10-13", "2030-10-19", { cateringHours: null, cateringOffset: 312.5 }),
  ];
  const t = text(renderToStaticMarkup(React.createElement(LaborTargetTable, { weeks, range: { from: "2030-10-06", to: "2030-10-13" } })));
  assert.match(t, /Oct 6–12 \$4,800 \$1,400 29\.2% 25\.0% \+\$200 \+10 h Oct 13–19/);
  assert.doesNotMatch(t, /h, \$|all-in \$|NaN|null/);
});

test("with every week in range complete, nothing sits under the chart but Show numbers and the method", () => {
  const html = render({ from: "2030-09-29", to: "2030-10-13" });
  const t = text(html);
  assert.match(t, /3 of 3 weeks complete/);
  assert.doesNotMatch(html, /Weeks not available/);
  assert.doesNotMatch(t, /catering crew billed/);
  assert.doesNotMatch(t, /not over yet|on file for/);
});

test("a week without its payroll reads n/a with the reason, never $0", () => {
  assert.match(table(DEFAULT), /Oct 27–Nov 2 \$4,800 n\/a n\/a 25\.0% n\/a n\/a/);
  const t = text(render({}));
  assert.match(t, /Oct 27: hourly payroll on file for 5 of 7 days/);
  assert.doesNotMatch(t, /\$0\b/);
});

test("a chosen range is shown; one past the weeks on file is cut to them; one wholly outside falls back to the default", () => {
  const sep = render({ from: "2030-09-01", to: "2030-09-29" });
  assert.match(sep, /weeks of Sep 1 to Sep 29/);
  assert.equal(selected(sep, "from-w1"), "2030-09-01");
  assert.equal(selected(sep, "to-w1"), "2030-09-29");
  assert.match(render({ from: "2030-10-27", to: "2030-12-29" }), /weeks of Oct 27 to Nov 3/);
  assert.match(render({ from: "2029-01-07", to: "2029-02-04" }), /weeks of Oct 6 to Oct 27/);
});

test("one month menu: Custom, then each month on file; it shows the month while the range is that month's weeks", () => {
  const unset = render({});
  assert.doesNotMatch(unset, /aria-label="[^"]*: the weeks whose Sunday is in/); // no month buttons
  assert.match(unset, /<label class="sr-only" for="month-w1">Month for Labor vs target/);
  assert.deepEqual(options(unset, "month-w1"), ["custom", "2030-09", "2030-10", "2030-11"]);
  assert.match(unset, /<option value="2030-09">Sep 2030<\/option>/);
  assert.match(unset, /<option value="custom"[^>]*>Custom<\/option>/);
  // The fixture's default range happens to be Oct's weeks, so Oct shows.
  assert.equal(selected(unset, "month-w1"), "2030-10");
  assert.equal(selected(render({}, { weeks: WEEKS, defaultRange: { from: "2030-10-13", to: "2030-11-03" } }), "month-w1"), "custom");
  // Oct 2030's weeks: Oct 6 to Oct 27.
  const oct = render({ from: "2030-10-06", to: "2030-10-27" });
  assert.equal(selected(oct, "month-w1"), "2030-10");
  assert.match(oct, /weeks of Oct 6 to Oct 27/);
  // Sep 2030's weeks run to Sep 29; Nov's are cut to the one on file.
  assert.equal(selected(render({ from: "2030-09-01", to: "2030-09-29" }), "month-w1"), "2030-09");
  assert.equal(selected(render({ from: "2030-11-03", to: "2030-11-24" }), "month-w1"), "2030-11");
  assert.equal(selected(render({ from: "2030-09-29", to: "2030-10-27" }), "month-w1"), "custom");
});

test("a view saved under the old month picker shows that month's weeks", () => {
  // Views are cleaned as they load (cleanWidgets): Sep 2030 is Sep 1 to Sep 29.
  const html = render({ month: "2030-09" });
  assert.match(html, /weeks of Sep 1 to Sep 29/);
  assert.equal(selected(html, "from-w1"), "2030-09-01");
  assert.equal(selected(html, "to-w1"), "2030-09-29");
});

test("when its reads fail the card says it could not load, with no picker", () => {
  const html = render({}, null);
  assert.match(text(html), /Could not load hourly payroll, daily sales or the control board\./);
  assert.doesNotMatch(html, /id="from-w1"/);
});

test("both sides read all-in; the catering crew taken off is in the table, not a note under the chart", () => {
  const t = text(render({}));
  assert.doesNotMatch(t, /catering crew billed to clients/);
  assert.match(t, /Show numbers. lists each week.s catering crew taken off, hours and all-in \$/);
  assert.match(t, /all-in hourly goal/);
  assert.match(t, /25\.0% of sales in these weeks/);
});
