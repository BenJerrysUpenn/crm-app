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

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { ...ACTIVE[0], role: "manager" },
      { ...ACTIVE[1], role: "employee" },
      { id: "p-gone", role: "employee", full_name: "Gone Hourly", hourly_rate: "12", pay_type: "hourly", active: false },
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
    profile_salaries: [],
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
      { id: 1, stage: "Booked Paid", payment_status: "Paid", event_date: "2030-10-14", created_at: "2030-09-01", subtotal_pretax: "400", total_with_tax: "432", amount_paid: "432", company: "Invented Co", source: "form", archived: 0 },
      { id: 2, stage: "Sent Quote", payment_status: null, event_date: "2030-10-14", created_at: "2030-09-01", subtotal_pretax: "999", total_with_tax: null, amount_paid: null, company: "Not Booked", source: "form", archived: 0 },
    ],
    deal_events: [],
  });
  db.signIn(MANAGER);
});

const at = (day: string, hh: number) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hh + 4)).toISOString();

test("a manager's week: last year's same weekdays, this year's booked catering, the board's goal, and an inactive person's shift at their rate", async () => {
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
  assert.equal(labor.days[1].catering.value, 400, "the booked deal counts; the quote does not");
  assert.ok(Math.abs((labor.days[1].projectedSales.value ?? 0) - 1_500) < 1e-6);
  assert.ok(Math.abs((labor.days[1].targetHours.value ?? 0) - 20) < 1e-6, "1,500 x 20% / an average of 15");
  assert.equal(labor.days[2].targetHours.value, null, "no last-year Tuesday on file");
  assert.equal(labor.labor.wages, 60, "5h at the inactive person's 12");
});

test("before migration 43 the line says so", async () => {
  db.missingTables.push("control_settings", "profile_salaries");
  const load = await loadScheduleLabor(createClient(), { weekStart: WEEK, today: TODAY, shifts: [], employees: ACTIVE, shiftTypes: [] });
  assert.deepEqual(load, { ready: false, reason: NEEDS_MIGRATION });
});

test("when the catering bookings cannot be read the line still draws, says what failed, and projected sales are missing", async () => {
  db.missingTables.push("deals");
  const load = await loadScheduleLabor(createClient(), { weekStart: WEEK, today: TODAY, shifts: [], employees: ACTIVE, shiftTypes: [] });
  assert.ok(load.ready);
  assert.match(load.problems[0], /^Catering bookings could not be read: /);
  assert.equal(load.labor.days[0].projectedSales.value, null);
});

test("a week still ahead takes its trend from the last full month before today", async () => {
  const load = await loadScheduleLabor(createClient(), { weekStart: "2030-11-03", today: TODAY, shifts: [], employees: ACTIVE, shiftTypes: [] });
  assert.ok(load.ready);
  assert.equal(load.labor.trend.lastMonth.month, "2030-09-01");
  assert.ok(Math.abs((load.labor.trend.factor.value ?? 0) - 1.1) < 1e-9);
});
