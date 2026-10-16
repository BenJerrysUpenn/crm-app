// The manager Schedule page as the manager reads it (bj-finance #695): the
// week reads as two lines,
//   Scheduled Hourly Labor: <hours>
//   Target Hourly Labor: <hours>
// with no divider, no total hours and no $, the day headers in the manager grid are just
// the day and date, and there is no "how the target is worked out" panel.
// The numbers come from lib/controlBoard/schedule.ts (pinned in its own
// tests); these render the board around them with react-dom/server.
// Invented figures only: crm-app is public.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadAppModule } from "./testing/fakeSupabase.ts";
import { trendFactor } from "./controlBoard/math.ts";
import { addDays, scheduleLabor, type LaborPerson, type ScheduleLaborInput } from "./controlBoard/schedule.ts";
import type { SettingRow } from "./controlBoard/settings.ts";
import type { ScheduleLaborLoad } from "./controlBoard/scheduleLoad.ts";

const { AppRouterContext } = createRequire(import.meta.url)(
  "next/dist/shared/lib/app-router-context.shared-runtime.js",
) as { AppRouterContext: import("react").Context<unknown> };

const { default: ScheduleBoard } = await loadAppModule<{ default: unknown }>("components/ScheduleBoard.tsx");

// The week of Sunday 2030-10-13. October in New York is UTC-4.
const WEEK = "2030-10-13";
const DATES = Array.from({ length: 7 }, (_, i) => addDays(WEEK, i));
const TODAY = "2030-10-10";

let nextId = 1;
const row = (key: string, value: number, detail: SettingRow["detail"] = {}): SettingRow => ({
  id: nextId++, key, value, detail, effective_from: "2030-01-01", review_by: "2031-12-31", source: "invented", method: null, recorded_by: null, recorded_at: "2030-01-01T00:00:00Z",
});

// Hourly goal 20% (as in controlBoard/schedule.test.ts); trend 1.1; average
// rate 15; last year 1,000 a day. Each day's target: 1,100 x 0.2 / 15 h.
const BOARD: SettingRow[] = [
  row("sales_estimate.in_store", 800_000),
  row("sales_estimate.catering", 200_000),
  row("target.payroll_pct", 0.25),
  row("tax.fica", 0.15, { wage_cap: null }),
  row("tax.futa", 0.05, { wage_cap: null }),
  row("tax.pa_uc", 0.04, { wage_cap: null }),
  row("tax.workers_comp", 1),
  row("rule.catering_premium", 2, { cap_rate: 21 }),
  row("rule.solo_close", 30, { min_alone_hours: 4, out_at_or_after: "22:00" }),
];

const PEOPLE: LaborPerson[] = [
  { id: "ten", name: "Ten Hourly", hourly_rate: 10, pay_type: "hourly", active: true },
  { id: "twenty", name: "Twenty Hourly", hourly_rate: 20, pay_type: "hourly", active: true },
  { id: "sal", name: "Sal Salaried", hourly_rate: null, pay_type: "salaried", active: true },
];

// Monday 12:00-20:00 New York: 8 hours for "ten".
const SHIFT = {
  id: 1, employee_id: "ten", location_id: null, starts_at: "2030-10-14T16:00:00.000Z", ends_at: "2030-10-15T00:00:00.000Z",
  position: "Scooper", notes: null, published: true, acknowledged_at: null, created_at: "2030-10-01T00:00:00Z", updated_at: "2030-10-01T00:00:00Z",
  profiles: { id: "ten", full_name: "Ten Hourly" },
};

// Tuesday 09:00-13:00 New York: 4 hours for the salaried "sal". On the board,
// so in total hours (12h), but not in Scheduled Hourly Labor (8h). Fixed
// payroll is left off (salaried: []) so the target stays the worked 102.7h.
const SAL_SHIFT = {
  ...SHIFT, id: 2, employee_id: "sal", starts_at: "2030-10-15T13:00:00.000Z", ends_at: "2030-10-15T17:00:00.000Z",
  profiles: { id: "sal", full_name: "Sal Salaried" },
};
const SHIFTS = [SHIFT, SAL_SHIFT];

function labor(over: Partial<ScheduleLaborInput> = {}): ScheduleLaborLoad {
  const l = scheduleLabor({
    dates: DATES,
    shifts: SHIFTS,
    people: new Map(PEOPLE.map((p) => [p.id, p])),
    inStoreByName: new Map([["Scooper", true]]),
    settings: BOARD,
    salaries: [],
    salaried: [],
    trend: trendFactor(TODAY, [
      { month: "2030-09-01", source: "qbo", in_store: 11_000 },
      { month: "2029-09-01", source: "seller", in_store: 10_000 },
    ], []),
    inStoreByDay: new Map(DATES.map((d) => [addDays(d, -364), 1_000])),
    cateringByDay: {},
    ...over,
  });
  return { ready: true, labor: l, problems: [] };
}

function renderBoard(load: ScheduleLaborLoad) {
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(ScheduleBoard as never, {
        isManager: true,
        weekStart: WEEK,
        shifts: SHIFTS,
        employees: PEOPLE.map((p) => ({ id: p.id, full_name: p.name, phone: null, role: "employee", hourly_rate: p.hourly_rate, active: true, pay_type: p.pay_type })),
        locations: [],
        dropRequests: [],
        shiftTypes: [{ id: 1, name: "Scooper", color: "#10b981", in_store: true }],
        labor: load,
      }),
    ),
  );
}

/** Visible text of some markup: tags and React's text-node comments dropped. */
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

/** The labor block, and its first two rows (the week's two lines). */
function laborLine(html: string) {
  const m = html.match(/<div class="[^"]*" data-testid="labor-line">([\s\S]*)$/);
  assert.ok(m, "the labor line is on the manager view");
  const rows = m[1].match(/^<div>([\s\S]*?)<\/div><div>([\s\S]*?)<\/div>/);
  assert.ok(rows, "the week's two lines are the labor block's first two rows");
  return { weekLines: [text(rows[1]), text(rows[2])], html: m[1] };
}

test("the week reads Scheduled Hourly Labor and Target Hourly Labor on two lines, in hours only, salaried hours left out", () => {
  const { weekLines } = laborLine(renderBoard(labor()));
  // 8h hourly scheduled (the salaried 4h is not hourly labor); target 7 x 1,100 x 0.2 / 15 = 102.67h.
  assert.deepEqual(weekLines, ["Scheduled Hourly Labor: 8.0h", "Target Hourly Labor: 102.7h"]);
});

test("the labor line shows no total hours, no dollar amounts and no divider when the labor is fully priced", () => {
  const { weekLines, html } = laborLine(renderBoard(labor()));
  const all = text(html);
  assert.doesNotMatch(all, /Total hours/);
  assert.doesNotMatch(all, /12\.0h/, "the 12h board total (hourly + salaried) is not shown");
  assert.doesNotMatch(all, /\$/);
  assert.doesNotMatch(all, /·/);
  for (const line of weekLines) assert.doesNotMatch(line, /[|/]/);
});

test("a missing target shows as missing, with the red Target missing line and its Targets-page link", () => {
  // No last-year sales on file: every day's target, and so the week's, is missing.
  const { weekLines, html } = laborLine(renderBoard(labor({ inStoreByDay: new Map() })));
  assert.deepEqual(weekLines, ["Scheduled Hourly Labor: 8.0h", "Target Hourly Labor: missing"]);
  assert.match(text(html), /Target missing: .+\. Board values are set on the Targets page\./);
  assert.match(html, /<a href="\/payroll\/targets"[^>]*>Targets page<\/a>/);
});

test("an empty board shows the target as missing and points to the Targets page", () => {
  const { weekLines, html } = laborLine(renderBoard(labor({ settings: [] })));
  assert.deepEqual(weekLines, ["Scheduled Hourly Labor: 8.0h", "Target Hourly Labor: missing"]);
  assert.match(text(html), /No labor target yet: nothing is entered on the control board\./);
});

test("the manager grid's day headers are just the day and date: no hours, no target, no board-not-set line", () => {
  const html = renderBoard(labor({ settings: [] }));
  const headers = [...html.matchAll(/<div class="px-2 py-2 text-xs font-medium[^"]*">([\s\S]*?)<\/div>/g)].map((m) => text(m[1]));
  assert.deepEqual(headers, ["Sun Oct 13", "Mon Oct 14", "Tue Oct 15", "Wed Oct 16", "Thu Oct 17", "Fri Oct 18", "Sat Oct 19"]);
  assert.doesNotMatch(text(html), /board not set/);
});

test("there is no 'How the target is worked out' panel", () => {
  const html = renderBoard(labor());
  assert.doesNotMatch(html, /How the target is worked out/);
  assert.doesNotMatch(html, /<details/);
});
