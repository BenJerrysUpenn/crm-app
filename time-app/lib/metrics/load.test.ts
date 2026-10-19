// What the Metrics page gets from one load (bj-finance #671): the Supabase
// reads in loadMetricsInputs, then buildMetricsData over them. Driven against
// the stand-in Supabase (lib/testing/fakeSupabase.ts) as a signed-in manager.
// Fixtures are synthetic.
//
//   npm test

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";
import { loadAppModule, startFakeSupabase, type FakeSupabase } from "../testing/fakeSupabase.ts";

const { loadMetricsInputs, buildMetricsData } = await loadAppModule<typeof import("./load.ts")>("lib/metrics/load.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SCOOPER = "00000000-0000-0000-0000-00000000000b";
// Saturday Oct 10 2026, noon in New York.
const NOW = new Date("2026-10-10T16:00:00Z");

function deal(over: Record<string, unknown>) {
  return {
    id: 1, stage: "Booked Paid", payment_status: "Paid in Full", event_date: "2026-10-04", created_at: "2026-10-06T15:00:00Z",
    subtotal_pretax: 1000, total_with_tax: 1080, amount_paid: 1080, company: "Test Co", source: "form", archived: 0, ...over,
  };
}

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Manager", hourly_rate: null, pay_type: "salaried" },
      { id: SCOOPER, role: "employee", active: true, full_name: "Scooper", hourly_rate: 15, pay_type: "hourly" },
    ],
    deals: [
      // Created and held this month: inside both the event-date and the created-date reads.
      deal({ id: 1 }),
      // A future Event Complete with no payment: the sweep defect, unless history says booked.
      deal({ id: 2, stage: "Event Complete", event_date: "2026-11-20", payment_status: "None", amount_paid: 0, subtotal_pretax: 400 }),
    ],
    deal_events: [],
    time_entries: [
      { id: 1, employee_id: SCOOPER, clock_in_at: "2026-10-05T16:00:00Z", clock_out_at: "2026-10-05T20:00:00Z", shift_id: null, status: "closed", manual: false },
    ],
    shifts: [],
    outreach_events: [{ id: 1, event: "sequenced", occurred_at: "2026-10-06T14:00:00Z" }],
    sales_targets: [{ month: "2026-10-01", stream: "catering", amount: "7000.00", basis: "test", provisional: false, measure: "net" }],
  });
  db.signIn(MANAGER);
});

// The network between the page and PostgREST, the system boundary: `answer`
// may take over one request (return a Response, or throw as fetch does)
// before it reaches the stand-in Supabase; undefined lets it through.
type Answer = (url: URL) => Response | undefined;

function managerClient(answer: Answer = () => undefined) {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: {
      headers: { Authorization: `Bearer token-for-${MANAGER}` },
      fetch: (input, init) => {
        const taken = answer(new URL(input instanceof Request ? input.url : String(input)));
        return taken ? Promise.resolve(taken) : fetch(input, init);
      },
    },
    auth: { persistSession: false },
  });
}

function refusal(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, details: null, hint: null, message }), { status, headers: { "content-type": "application/json" } });
}

test("a deal in both the event-date and the created-date windows is counted once", async () => {
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.equal(data.today, "2026-10-10");
  assert.deepEqual(data.problems, []);
  assert.equal(data.catering?.byDay["2026-10-04"], 1000);
  assert.equal(data.leads?.at(-1)?.total, 2); // both deals created the week of Oct 5, deal 1 once
});

test("the targets come from the sales_targets table, its amounts as numbers", async () => {
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.deepEqual(data.targets?.map((t) => t.amount), [7000]);
});

test("a missing sales_targets table leaves the targets unavailable and says so; there is no bundled copy", async () => {
  db.missingTables = ["sales_targets"];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.equal(data.targets, null);
  assert.deepEqual(data.problems.map((p) => p.split(":")[0]), ["sales targets"]);
  assert.equal(data.catering?.byDay["2026-10-04"], 1000);
});

test("a sales_targets read that is refused leaves the targets unavailable and says why", async () => {
  const client = managerClient((url) =>
    url.pathname.endsWith("/sales_targets") ? refusal(403, "42501", "permission denied for table sales_targets") : undefined,
  );
  const data = buildMetricsData(await loadMetricsInputs(client, NOW));
  assert.equal(data.targets, null);
  assert.deepEqual(data.problems, ["sales targets: permission denied for table sales_targets"]);
});

test("a sales_targets request that never completes leaves the targets unavailable and says why", async () => {
  const client = managerClient((url) => {
    if (url.pathname.endsWith("/sales_targets")) throw new DOMException("The request was aborted", "AbortError");
    return undefined;
  });
  const data = buildMetricsData(await loadMetricsInputs(client, NOW));
  assert.equal(data.targets, null);
  assert.deepEqual(data.problems, ["sales targets: AbortError: The request was aborted"]);
});

test("before profiles has pay_type the people read is a problem, never a read without it; labour and forward do not draw", async () => {
  const client = managerClient((url) =>
    url.pathname.endsWith("/profiles") && url.searchParams.get("select")?.includes("pay_type")
      ? refusal(400, "42703", "column profiles.pay_type does not exist")
      : undefined,
  );
  const data = buildMetricsData(await loadMetricsInputs(client, NOW));
  // Labor vs target prices the catering crew from the team, so it cannot load
  // either; Labor Hours Planning takes its average rate from the team.
  assert.deepEqual(data.problems, [
    "people: column profiles.pay_type does not exist",
    "labor vs target: column profiles.pay_type does not exist",
    "labor hours planning: column profiles.pay_type does not exist",
  ]);
  assert.equal(data.laborTarget, null);
  assert.equal(data.laborPlanning, null);
  assert.equal(data.labour, null);
  assert.equal(data.forward, null);
  assert.equal(data.catering?.byDay["2026-10-04"], 1000);
});

test("a section that cannot load is null and named in problems, never zeros; the rest still draws", async () => {
  db.missingTables = ["outreach_events", "shifts"];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.equal(data.outreach, null);
  assert.equal(data.labour, null); // hours need the shifts to split catering from in-store
  assert.equal(data.forward, null);
  assert.equal(data.laborTarget, null); // the catering crew's shifts price its offset
  assert.equal(data.laborPlanning, null); // booked catering is its Catering shifts
  assert.deepEqual(data.problems.map((p) => p.split(":")[0]).sort(), ["labor hours planning", "labor vs target", "outreach", "shifts"]);
  assert.equal(data.catering?.byDay["2026-10-04"], 1000);
});

test("when the deals cannot load, every deal-based widget is null rather than empty", async () => {
  db.missingTables = ["deals"];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.equal(data.catering, null);
  assert.equal(data.ar, null);
  assert.equal(data.leads, null);
  assert.equal(data.quotes, null);
  assert.deepEqual(data.problems.map((p) => p.split(":")[0]).sort(), ["catering deals", "labor hours planning", "labor vs target", "new enquiries"]);
  // Labor Hours Planning still draws, saying booked catering could not be read.
  assert.ok(data.laborPlanning?.weeks[0].notes.some((n) => n.startsWith("catering bookings could not be read")));
  // The card still draws, with no labor for a week whose catering offset cannot be known.
  assert.ok(data.laborTarget?.weeks.find((w) => w.start === "2026-09-06")?.why.includes("catering bookings could not be read"));
  assert.equal(data.outreach?.at(-1)?.sent, 1);
});

test("a future Event Complete is flagged as suspect, until the stage history shows it was booked", async () => {
  const flagged = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.deepEqual(flagged.catering?.suspect, [{ id: 2, company: "Test Co", eventDay: "2026-11-20" }]);
  assert.equal(flagged.catering?.byDay["2026-11-20"] ?? 0, 0);

  db.rows("deal_events").push({ id: 1, deal_id: 2, field: "stage", new_value: "Booked Paid", at: "2026-10-01T12:00:00Z" });
  const booked = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.deepEqual(booked.catering?.suspect, []);
  assert.equal(booked.catering?.byDay["2026-11-20"], 400);
});

test("clocked hours reach the labour widget, costed at the hourly rate", async () => {
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const week = data.labour?.weeks.at(-1);
  assert.equal(week?.week, "2026-10-05");
  assert.equal(week?.inStoreHours, 4);
  assert.equal(week?.inStoreHourlyCost, 60);
});

// ---- Labor vs target (bj-finance #696) ------------------------------------------------------

const SEPT_WEEK = ["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"];

function seedLaborTarget() {
  // Invented: payroll 25% of 100,000; taxes and comp 25% of wages; nobody salaried. A 20% hourly goal, 25% with taxes and comp.
  const setting = (id: number, key: string, value: number, detail: Record<string, unknown> = {}) => ({
    id, key, value, detail, effective_from: "2026-01-01", review_by: "2027-12-31", source: "invented", method: null, recorded_by: null, recorded_at: "2026-01-01T00:00:00Z",
  });
  db.tables.control_settings = [
    setting(1, "sales_estimate.in_store", 80_000),
    setting(2, "sales_estimate.catering", 20_000),
    setting(3, "target.payroll_pct", 0.25),
    setting(4, "tax.fica", 0.15, { wage_cap: null }),
    setting(5, "tax.futa", 0.05, { wage_cap: null }),
    setting(6, "tax.pa_uc", 0.04, { wage_cap: null }),
    setting(7, "tax.workers_comp", 1),
  ];
  db.tables.profile_salaries = [];
  // Each day 10 hours and 160 paid (as PostgREST sends numerics: strings), 200 with taxes and comp; sales 700 a day.
  db.tables.labor_daily_actuals = SEPT_WEEK.map((day) => ({
    day, hours: "10.00", wages: "150.00", catering_premium: "6.00", solo_close: "4.00", period_start: "2026-08-31", period_end: "2026-09-13", source: "punches", built_by: "test", updated_at: "2026-09-15T00:00:00Z",
  }));
  db.tables.sales_daily_in_store = SEPT_WEEK.map((day) => ({ day, in_store: "700.00", basis: "booked", source: "square" }));
}

test("labor vs target: every week on offer, the last 8 over by default, from the paid actuals, the daily sales and the board", async () => {
  seedLaborTarget();
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.deepEqual(data.problems, []);
  // NOW is Saturday Oct 10: the week of Oct 4 is not over, so the default ends with Sep 27.
  assert.deepEqual(data.laborTarget?.defaultRange, { from: "2026-08-09", to: "2026-09-27" });
  const starts = data.laborTarget!.weeks.map((w) => w.start);
  assert.equal(starts[0], "2026-05-03");
  assert.equal(starts.at(-1), "2026-10-04");
  assert.equal(starts.length, 23);
  const i = starts.indexOf("2026-09-06");
  const [first, second] = data.laborTarget!.weeks.slice(i, i + 2);
  assert.equal(first.available, true);
  assert.equal(first.sales, 4_900);
  assert.equal(first.actual, 1_400);
  assert.equal(first.targetPct.value, 0.25);
  assert.equal(first.varianceDollars, 1_400 - 1_225);
  // No payroll on file for the next week: not available, never zero.
  assert.equal(second.available, false);
  assert.equal(second.actual, null);
  assert.deepEqual(second.why, ["hourly payroll on file for 0 of 7 days", "in-store sales on file for 0 of 7 days"]);
});

test("labor vs target: a booked deal's billed crew hours come off the week's labor at crew cost + premium, all-in", async () => {
  seedLaborTarget();
  // Invented: a premium of 5 an hour; the one active hourly person is on 15, so the crew costs 20 an hour.
  (db.tables.control_settings as Record<string, unknown>[]).push({
    id: 8, key: "rule.catering_premium", value: 5, detail: { cap_rate: null }, effective_from: "2026-01-01", review_by: "2027-12-31", source: "invented", method: null, recorded_by: null, recorded_at: "2026-01-01T00:00:00Z",
  });
  // Booked on Tuesday the 8th: 5 hours x 2 crew = 10 billed hours, 200 of crew cost, 250 with taxes and comp.
  db.tables.deals.push(deal({ id: 3, event_date: "2026-09-08", labor_hours: "5", staff_count: 2 }));
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.deepEqual(data.problems, []);
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, true);
  assert.equal(first.cateringHours, 10);
  assert.equal(first.cateringOffset, 250);
  assert.equal(first.actual, 1_150);
  assert.equal(first.targetPct.value, 0.25);
  assert.equal(first.varianceDollars, 1_150 - 1_225);
});

test("labor vs target: whoever is on the deal's Catering shift sets the crew rate, as on the schedule, even someone no longer active", async () => {
  seedLaborTarget();
  db.tables.control_settings.push({
    id: 8, key: "rule.catering_premium", value: 5, detail: { cap_rate: null }, effective_from: "2026-01-01", review_by: "2027-12-31", source: "invented", method: null, recorded_by: null, recorded_at: "2026-01-01T00:00:00Z",
  });
  // Invented: a former scooper on 25 an hour crews deal 3 on Tuesday the 8th; the active average stays 15.
  const FORMER = "00000000-0000-0000-0000-00000000000c";
  db.tables.profiles.push({ id: FORMER, role: "employee", active: false, full_name: "Former Scooper", hourly_rate: 25, pay_type: "hourly" });
  db.tables.shifts.push({ id: 1, employee_id: FORMER, starts_at: "2026-09-08T16:00:00Z", ends_at: "2026-09-08T21:00:00Z", position: "Catering", deal_id: 3 });
  // 5 hours x 2 crew = 10 billed hours at 25 + 5 = 300 of crew cost, 375 with taxes and comp.
  db.tables.deals.push(deal({ id: 3, event_date: "2026-09-08", labor_hours: "5", staff_count: 2 }));
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, true);
  assert.equal(first.cateringOffset, 375);
  assert.equal(first.actual, 1_025);
});

test("labor vs target: a booked deal with no billed crew hours reads n/a for its week, naming the deal", async () => {
  seedLaborTarget();
  db.tables.control_settings.push({
    id: 8, key: "rule.catering_premium", value: 5, detail: { cap_rate: null }, effective_from: "2026-01-01", review_by: "2027-12-31", source: "invented", method: null, recorded_by: null, recorded_at: "2026-01-01T00:00:00Z",
  });
  db.tables.deals.push(deal({ id: 4, event_date: "2026-09-09", labor_hours: null, staff_count: null }));
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, false);
  assert.equal(first.actual, null);
  assert.ok(first.why.includes("no billed crew hours on catering deal #4"), first.why.join("; "));
});

// A past week is judged by the board as it stood that week (bj-finance #696):
// live, every week read n/a because today's board was applied to it.

test("labor vs target: a week before the catering premium was first set prices the crew at cost and is available", async () => {
  seedLaborTarget();
  // Invented: the premium's only row starts Oct 1, after the September week.
  db.tables.control_settings.push({ id: 8, key: "rule.catering_premium", value: 5, detail: { cap_rate: null }, effective_from: "2026-10-01", review_by: "2027-12-31", source: "invented", method: null, recorded_by: null, recorded_at: "2026-10-01T00:00:00Z" });
  // 5 hours x 2 crew = 10 billed hours at the active average of 15, no premium: 150, 187.50 with taxes and comp.
  db.tables.deals.push(deal({ id: 3, event_date: "2026-09-08", labor_hours: "5", staff_count: 2 }));
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, true, first.why.join("; "));
  assert.equal(first.cateringOffset, 187.5);
  assert.equal(first.actual, 1_212.5);
});

test("labor vs target: a week's fixed payroll is the people salaried that week, hired later out and archived later in", async () => {
  seedLaborTarget();
  // Invented: one salaried person hired Oct 1 (their only salary row starts then), one archived Oct 1 on 10,000 a year.
  db.tables.profiles.push(
    { id: "p-new", role: "manager", active: true, full_name: "Hired In October", hourly_rate: null, pay_type: "salaried", archived_at: null, is_overhead: false },
    { id: "p-gone", role: "manager", active: false, full_name: "Left In October", hourly_rate: null, pay_type: "salaried", archived_at: "2026-10-01T15:00:00Z", is_overhead: false },
  );
  db.tables.profile_salaries = [
    { id: 1, profile_id: "p-new", annual_salary: "50000.00", effective_from: "2026-10-01", review_by: "2027-12-31", source: "invented", method: null, recorded_by: null, recorded_at: "2026-10-01T00:00:00Z" },
    { id: 2, profile_id: "p-gone", annual_salary: "10000.00", effective_from: "2026-01-01", review_by: "2027-12-31", source: "invented", method: null, recorded_by: null, recorded_at: "2026-01-01T00:00:00Z" },
  ];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, true, first.why.join("; "));
  // 25,000 of payroll target less 10,000 x 1.25 of fixed payroll = 12,500 of 100,000.
  assert.equal(first.targetPct.value, 0.125);
});

test("labor vs target: a deal billed zero crew hours (a pickup) takes nothing off, whatever its staff count", async () => {
  seedLaborTarget();
  // PostgREST sends the numeric labor_hours as a string; no staff count on file.
  db.tables.deals.push(deal({ id: 5, event_date: "2026-09-08", labor_hours: "0", staff_count: null }));
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, true, first.why.join("; "));
  assert.equal(first.cateringHours, 0);
  assert.equal(first.actual, 1_400);
});

test("labor vs target: when the paid actuals cannot be read the card cannot load and says so; the rest still draws", async () => {
  seedLaborTarget();
  db.missingTables = ["labor_daily_actuals"];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.equal(data.laborTarget, null);
  assert.deepEqual(data.problems.map((p) => p.split(":")[0]), ["labor vs target"]);
  assert.equal(data.catering?.byDay["2026-10-04"], 1000);
});

// ---- Labor Hours Planning (bj-finance #742) -------------------------------------------------

const rev = (over: Record<string, unknown>) => ({
  id: 1, effective_from: "2026-09-01", review_by: "2026-12-31", source: "invented", method: null, recorded_by: null,
  recorded_at: "2026-09-01T12:00:00Z", cancelled: false, ...over,
});

test("labor hours planning reads seasons, the events in force and last year's catering hours (migration 47)", async () => {
  const days = [0, 1, 2, 3, 4, 5, 6];
  db.tables.store_hours = days.map((weekday) => ({ weekday, is_closed: false, opens: "10:00:00", closes: "21:00:00" }));
  // From Wednesday Oct 7: 13:00 to 21:00.
  db.tables.store_hours_seasons = days.map((weekday) => ({ effective_from: "2026-10-07", weekday, name: "Test season", is_closed: false, opens: "13:00:00", closes: "21:00:00" }));
  db.tables.concession_events = [
    rev({ id: 1, event_key: "test-expo", name: "Test Expo", start_date: "2026-10-12", end_date: "2026-10-13", expected_net_sales: "100.00", provisional: false }),
    rev({ id: 2, event_key: "test-expo", name: "Test Expo", start_date: "2026-10-05", end_date: "2026-10-06", expected_net_sales: "200.00", provisional: false, effective_from: "2026-09-15" }),
    rev({ id: 3, event_key: "test-fair", name: "Test Fair", start_date: "2026-10-05", end_date: "2026-10-05", expected_net_sales: "50.00", provisional: false, cancelled: true }),
  ];
  db.tables.crew_events = [rev({ id: 1, event_key: "test-cone", name: "Test Cone Day", day: "2026-10-08", crew_hours: "9.00" })];
  db.tables.catering_hours_history = ["2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08", "2025-10-09", "2025-10-10", "2025-10-11"].map((day) => ({
    day, hours: day === "2025-10-07" ? "6.00" : "0.00", shifts: 0, excluded_hours: 0, excluded_reason: null, source: "when_i_work", built_by: "test", updated_at: NOW.toISOString(),
  }));
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const week = data.laborPlanning?.weeks[0];
  assert.equal(week?.start, "2026-10-04");
  assert.equal(week?.coverageHours.value, 3 * 11 + 4 * 8, "the season from its first day");
  assert.equal(week?.concessionSales, 200, "the revision in force; the cancelled event is gone");
  assert.deepEqual(week?.events, ["Test Expo", "Test Cone Day"]);
  assert.equal(week?.lastYearCatering, 6);
  assert.equal(week?.estimatedHours.value, 6 + 9);
  assert.ok(week?.notes.some((n) => n.includes("#1")), "the booked deal with no billed crew hours is named");
});

test("labor hours planning before migration 47: the weekly hours, no events, and the estimate waits, saying why", async () => {
  db.tables.store_hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_closed: false, opens: "10:00:00", closes: "21:00:00" }));
  db.missingTables = ["store_hours_seasons", "concession_events", "crew_events", "catering_hours_history"];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const week = data.laborPlanning?.weeks[0];
  assert.equal(week?.coverageHours.value, 7 * 11);
  assert.deepEqual(week?.events, []);
  assert.equal(week?.estimatedHours.value, null);
  assert.ok(data.problems.includes("labor hours planning: last year's catering hours are not loaded yet (migration 47)"));
});
