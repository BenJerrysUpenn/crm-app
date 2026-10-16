// What the Schedule page reads for its labor line (bj-finance #695):
// loadScheduleLabor() drives the real supabase-js client against the
// stand-in Supabase project (testing/fakeSupabase.ts), as the signed-in
// manager. Invented figures only; crm-app is public.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAppModule, startFakeSupabase, type FakeSupabase } from "../testing/fakeSupabase.ts";

type LoadModule = typeof import("./scheduleLoad.ts");
const { loadScheduleLabor } = await loadAppModule<LoadModule>("lib/controlBoard/scheduleLoad.ts");
const { NEEDS_MIGRATION } = await loadAppModule<typeof import("./load.ts")>("lib/controlBoard/load.ts");
const { createClient } = await loadAppModule<{ createClient: () => SupabaseClient }>("lib/supabase/server.ts");

const WEEK = "2030-10-13";
const TODAY = "2030-10-10";
const MANAGER = "00000000-0000-0000-0000-0000000000b1";
const NOTE = { review_by: "2031-12-31", source: "invented", method: null, recorded_by: MANAGER, recorded_at: "2030-01-01T00:00:00Z", effective_from: "2030-01-01" };

const ACTIVE: { id: string; full_name: string; hourly_rate: string; pay_type: "hourly"; active: boolean }[] = [
  { id: MANAGER, full_name: "Store Manager", hourly_rate: "10", pay_type: "hourly", active: true },
  { id: "p-twenty", full_name: "Twenty Hourly", hourly_rate: "20", pay_type: "hourly", active: true },
];

let db: FakeSupabase;

// The stand-in project answers every read with every column, whatever
// select() names; hosted PostgREST returns only the named ones. Reads of
// `table` get just the selected columns, so a column the loader forgets to
// select arrives missing here as it would in production.
function returnOnlySelectedColumnsOf(table: string) {
  const project = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const select = url.searchParams.get("select");
    const response = await project(request);
    if (request.method !== "GET" || url.pathname !== `/rest/v1/${table}` || !select || select === "*" || !response.ok) return response;
    const columns = select.split(",");
    const rows = (await response.json()) as Record<string, unknown>[];
    return Response.json(rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]]))), { status: response.status });
  }) as typeof fetch;
}

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      // is_overhead is NOT NULL DEFAULT false in the database (migration 45).
      { ...ACTIVE[0], role: "manager", is_overhead: false },
      { ...ACTIVE[1], role: "employee", is_overhead: false },
      { id: "p-gone", role: "employee", full_name: "Gone Hourly", hourly_rate: "12", pay_type: "hourly", active: false, is_overhead: false },
      { id: "p-gone-overhead", role: "employee", full_name: "Gone Overhead", hourly_rate: "30", pay_type: "hourly", active: false, is_overhead: true },
      { id: "p-overhead-salaried", role: "manager", full_name: "Overhead Salaried", hourly_rate: null, pay_type: "salaried", active: true, is_overhead: true },
    ],
    // Sales 800,000 + 200,000, payroll 25%, taxes and comp 25% of wages: a 20% hourly goal.
    control_settings: [
      { id: 1, key: "sales_estimate.in_store", value: "800000", detail: {}, ...NOTE },
      { id: 2, key: "sales_estimate.catering", value: "200000", detail: {}, ...NOTE },
      { id: 3, key: "target.payroll_pct", value: "0.25", detail: {}, ...NOTE },
      { id: 4, key: "tax.fica", value: "0.15", detail: { wage_cap: null }, ...NOTE },
      { id: 5, key: "tax.futa", value: "0.05", detail: { wage_cap: null }, ...NOTE },
      { id: 6, key: "tax.pa_uc", value: "0.04", detail: { wage_cap: null }, ...NOTE },
      { id: 7, key: "tax.workers_comp", value: "1", detail: {}, ...NOTE },
    ],
    profile_salaries: [
      { id: 1, profile_id: "p-overhead-salaried", annual_salary: "50000.00", ...NOTE },
    ],
    sales_monthly: [
      { month: "2030-09-01", source: "qbo", in_store: "11000.00" },
      { month: "2029-09-01", source: "seller", in_store: "10000.00" },
    ],
    // Sunday and Monday of the same week 52 weeks earlier.
    sales_daily_in_store: [
      { day: "2029-10-14", in_store: "1000.00", basis: "booked", source: "seller" },
      { day: "2029-10-15", in_store: "1000.00", basis: "booked", source: "seller" },
      { day: "2029-10-22", in_store: "9999.00", basis: "booked", source: "seller" },
    ],
    deals: [
      // Booked: 2 crew billed 4h each = 8 crew hours.
      { id: 1, stage: "Booked Paid", payment_status: "Paid", event_date: "2030-10-14", created_at: "2030-09-01", subtotal_pretax: "400", total_with_tax: "432", amount_paid: "432", company: "Invented Co", source: "form", archived: 0, labor_hours: 4, staff_count: 2 },
      { id: 2, stage: "Sent Quote", payment_status: null, event_date: "2030-10-14", created_at: "2030-09-01", subtotal_pretax: "999", total_with_tax: null, amount_paid: null, company: "Not Booked", source: "form", archived: 0, labor_hours: 5, staff_count: 3 },
    ],
    deal_events: [],
  });
  db.signIn(MANAGER);
  returnOnlySelectedColumnsOf("profiles");
  returnOnlySelectedColumnsOf("deals");
});

const at = (day: string, hh: number) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hh + 4)).toISOString();

test("a manager's week: last year's same weekdays, the booked deal's billed crew hours, the board's goal, and an inactive person's shift at their rate", async () => {
  const load = await loadScheduleLabor(createClient(), {
    weekStart: WEEK,
    today: TODAY,
    shifts: [{ id: 1, employee_id: "p-gone", starts_at: at("2030-10-14", 12), ends_at: at("2030-10-14", 17), position: "Scooper" }],
    employees: ACTIVE,
    shiftTypes: [{ name: "Scooper", in_store: true }],
  });
  assert.ok(load.ready);
  const { labor } = load;
  assert.deepEqual(load.problems, []);
  assert.equal(labor.boardEmpty, false);
  assert.equal(labor.days[0].lastYearInStore.value, 1_000);
  assert.equal(labor.days[1].cateringHours.value, 8, "the booked deal's 4h x 2 crew; the quote does not count");
  assert.ok(Math.abs((labor.days[1].projectedSales.value ?? 0) - 1_100) < 1e-6, "in-store only: the deal's $ is not in it");
  assert.ok(Math.abs((labor.days[1].targetHours.value ?? 0) - (220 / 15 + 8)) < 1e-6, "1,100 x 20% / an average of 15, plus the 8 billed crew hours");
  assert.equal(labor.days[2].targetHours.value, null, "no last-year Tuesday on file");
  assert.equal(labor.labor.wages, 60, "5h at the inactive person's 12");
});

test("before migration 43 the line says so", async () => {
  db.missingTables.push("control_settings", "profile_salaries");
  const load = await loadScheduleLabor(createClient(), { weekStart: WEEK, today: TODAY, shifts: [], employees: ACTIVE, shiftTypes: [] });
  assert.deepEqual(load, { ready: false, reason: NEEDS_MIGRATION });
});

test("when the catering bookings cannot be read the line still draws, says what failed, and the target is missing", async () => {
  db.missingTables.push("deals");
  const load = await loadScheduleLabor(createClient(), { weekStart: WEEK, today: TODAY, shifts: [], employees: ACTIVE, shiftTypes: [] });
  assert.ok(load.ready);
  assert.match(load.problems[0], /^Catering bookings could not be read: /);
  assert.equal(load.labor.days[0].cateringHours.value, null);
  assert.equal(load.labor.days[0].targetHours.value, null);
});

test("a week still ahead takes its trend from the last full month before today", async () => {
  const load = await loadScheduleLabor(createClient(), { weekStart: "2030-11-03", today: TODAY, shifts: [], employees: ACTIVE, shiftTypes: [] });
  assert.ok(load.ready);
  assert.equal(load.labor.trend.lastMonth.month, "2030-09-01");
  assert.ok(Math.abs((load.labor.trend.factor.value ?? 0) - 1.1) < 1e-9);
});

test("when last year's daily sales cannot be read the line says so and every day's target is missing, not zero", async () => {
  db.missingTables.push("sales_daily_in_store");
  const load = await loadScheduleLabor(createClient(), { weekStart: WEEK, today: TODAY, shifts: [], employees: ACTIVE, shiftTypes: [] });
  assert.ok(load.ready);
  assert.ok(load.problems.some((p) => p.startsWith("Last year's daily sales could not be read: ")), load.problems.join(" | "));
  assert.equal(load.labor.days[0].lastYearInStore.value, null);
  assert.equal(load.labor.days[0].targetHours.value, null);
});

test("when the booking history cannot be read, catering is missing rather than guessed", async () => {
  db.missingTables.push("deal_events");
  const load = await loadScheduleLabor(createClient(), { weekStart: WEEK, today: TODAY, shifts: [], employees: ACTIVE, shiftTypes: [] });
  assert.ok(load.ready);
  assert.match(load.problems[0], /^Catering bookings could not be read: /);
  assert.equal(load.labor.days[1].cateringHours.value, null);
  assert.equal(load.labor.days[1].targetHours.value, null);
});

test("a booked deal with no billed crew hours makes the target missing, naming the deal", async () => {
  db.tables.deals.push({ id: 3, stage: "Booked Paid", payment_status: "Paid", event_date: "2030-10-14", created_at: "2030-09-01", subtotal_pretax: "300", total_with_tax: null, amount_paid: "100", company: "No Hours Co", source: "form", archived: 0, labor_hours: null, staff_count: 2 });
  const load = await loadScheduleLabor(createClient(), { weekStart: WEEK, today: TODAY, shifts: [], employees: ACTIVE, shiftTypes: [] });
  assert.ok(load.ready);
  assert.equal(load.labor.days[1].targetHours.value, null);
  assert.deepEqual(load.labor.days[1].targetHours.needs, ["no billed crew hours on catering deal #3"]);
  assert.ok(load.labor.target.hours.needs.includes("no billed crew hours on catering deal #3"), "the week line names the deal");
});

test("the deal's crew on its Catering shifts sets the crew cost, with the board's premium", async () => {
  db.tables.control_settings.push({ id: 9, key: "rule.catering_premium", value: "2", detail: { cap_rate: 21 }, ...NOTE });
  const load = await loadScheduleLabor(createClient(), {
    weekStart: WEEK,
    today: TODAY,
    shifts: [
      { id: 1, employee_id: "p-twenty", starts_at: at("2030-10-14", 10), ends_at: at("2030-10-14", 14), position: "Catering", deal_id: 1 },
      { id: 2, employee_id: "p-twenty", starts_at: at("2030-10-14", 10), ends_at: at("2030-10-14", 14), position: "Catering", deal_id: 1 },
    ],
    employees: ACTIVE,
    shiftTypes: [{ name: "Catering", in_store: false }],
  });
  assert.ok(load.ready);
  assert.equal(load.labor.days[1].cateringDollars.value, 8 * 21, "8 billed hours at 20 + 2, capped at 21");
  assert.equal(load.labor.labor.total, 8 * 21, "the same on the scheduled side: it nets to zero");
});

test("a shift type marked not in-store does not close the night for the solo-close bonus", async () => {
  db.tables.control_settings.push({ id: 8, key: "rule.solo_close", value: "30", detail: { min_alone_hours: 4, out_at_or_after: "22:00" }, ...NOTE });
  const shifts = [
    { id: 1, employee_id: MANAGER, starts_at: at("2030-10-14", 12), ends_at: at("2030-10-14", 18), position: "Scooper" },
    { id: 2, employee_id: "p-twenty", starts_at: at("2030-10-14", 18), ends_at: at("2030-10-14", 23), position: "Delivery" },
  ];
  const asInStore = await loadScheduleLabor(createClient(), { weekStart: WEEK, today: TODAY, shifts, employees: ACTIVE, shiftTypes: [{ name: "Scooper", in_store: true }, { name: "Delivery", in_store: true }] });
  const notInStore = await loadScheduleLabor(createClient(), { weekStart: WEEK, today: TODAY, shifts, employees: ACTIVE, shiftTypes: [{ name: "Scooper", in_store: true }, { name: "Delivery", in_store: false }] });
  assert.ok(asInStore.ready && notInStore.ready);
  assert.equal(asInStore.labor.labor.solo, 30, "alone 18:00-23:00, out at 23:00");
  assert.equal(notInStore.labor.labor.solo, 0, "the in-store closer is out at 18:00");
});

test("overhead staff: an overhead salary stays out of the goal, and an overhead person's shift and rate stay out of hourly labor", async () => {
  const load = await loadScheduleLabor(createClient(), {
    weekStart: WEEK,
    today: TODAY,
    shifts: [
      { id: 1, employee_id: "p-gone-overhead", starts_at: at("2030-10-14", 12), ends_at: at("2030-10-14", 17), position: "Scooper" },
      { id: 2, employee_id: "p-overhead-salaried", starts_at: at("2030-10-14", 9), ends_at: at("2030-10-14", 12), position: "Scooper" },
    ],
    employees: [...ACTIVE, { id: "p-active-overhead", full_name: "Active Overhead", hourly_rate: "40", pay_type: "hourly", active: true, is_overhead: true }],
    shiftTypes: [{ name: "Scooper", in_store: true }],
  });
  assert.ok(load.ready);
  const { labor } = load;
  assert.ok(Math.abs((labor.days[0].hourlyGoal.value ?? 0) - 0.2) < 1e-9, "the overhead salary is not fixed payroll: the goal stays 20%");
  assert.equal(labor.avgRate.value, 15, "the active overhead person's rate is not in the average");
  assert.equal(labor.totalHours, 8, "both overhead shifts count in total hours");
  assert.equal(labor.hourlyHours, 0);
  assert.equal(labor.labor.wages, 0, "the inactive overhead person's shift is read as overhead too");
  assert.ok(!labor.labor.notCounted.some((n) => /Overhead/.test(n)), "overhead people are not listed as gaps");
});
