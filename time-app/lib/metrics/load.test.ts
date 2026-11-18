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

const { loadMetricsInputs, buildMetricsData, dealsFrom } = await loadAppModule<typeof import("./load.ts")>("lib/metrics/load.ts");

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
  // Labor Hours Planning takes its average rate from the team. Labor vs target
  // reads no team: its labor is as paid, from the labor days.
  assert.deepEqual(data.problems, [
    "people: column profiles.pay_type does not exist",
    "labor hours planning: column profiles.pay_type does not exist",
  ]);
  assert.ok(data.laborTarget);
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
  assert.ok(data.laborTarget); // its catering work is as paid, from the labor days, not the shifts
  assert.equal(data.laborPlanning, null); // booked catering is its Catering shifts
  assert.deepEqual(data.problems.map((p) => p.split(":")[0]).sort(), ["labor hours planning", "outreach", "shifts"]);
  assert.equal(data.catering?.byDay["2026-10-04"], 1000);
});

test("when the deals cannot load, every deal-based widget is null rather than empty", async () => {
  db.missingTables = ["deals"];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.equal(data.catering, null);
  assert.equal(data.ar, null);
  assert.equal(data.leads, null);
  assert.equal(data.quotes, null);
  // Labor Hours Planning names both its deal reads.
  assert.deepEqual(data.problems.map((p) => p.split(":")[0]).sort(), ["catering deals", "labor hours planning", "labor hours planning", "new enquiries"]);
  // Labor Hours Planning still draws, saying booked catering and marketing deals could not be read.
  assert.ok(data.laborPlanning?.weeks[0].notes.some((n) => n.startsWith("catering bookings could not be read")));
  assert.ok(data.laborPlanning?.weeks[0].notes.some((n) => n.startsWith("marketing deals could not be read")));
  // Labor vs target counts catering sales (Alina, 2026-11-18): without the deals it cannot load, never a week without its catering.
  assert.equal(data.laborTarget, null);
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

test("clocked hours reach the labour widget, costed at the hourly rate, in Sunday-to-Saturday weeks", async () => {
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const week = data.labour?.weeks.at(-1);
  assert.equal(week?.week, "2026-10-04"); // the Sunday of Monday Oct 5's week
  assert.equal(week?.inStoreHours, 4);
  assert.equal(week?.inStoreHourlyCost, 60);
});

test("the labour widget splits punches by the shift's work, reading each deal's event type for marketing deals", async () => {
  db.tables.deals.push({ ...deal({ id: 8, event_date: "2026-10-07" }), event_type: "Marketing Event" });
  db.tables.shifts.push(
    { id: 31, employee_id: SCOOPER, starts_at: "2026-10-06T16:00:00Z", ends_at: "2026-10-06T19:00:00Z", position: "Catering", deal_id: 1 },
    { id: 32, employee_id: SCOOPER, starts_at: "2026-10-07T16:00:00Z", ends_at: "2026-10-07T18:00:00Z", position: "Catering", deal_id: 8 },
  );
  db.tables.time_entries.push(
    { id: 2, employee_id: SCOOPER, clock_in_at: "2026-10-06T16:00:00Z", clock_out_at: "2026-10-06T19:00:00Z", shift_id: 31, status: "closed", manual: false },
    { id: 3, employee_id: SCOOPER, clock_in_at: "2026-10-07T16:00:00Z", clock_out_at: "2026-10-07T18:00:00Z", shift_id: 32, status: "closed", manual: false },
  );
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const week = data.labour?.weeks.at(-1);
  assert.equal(week?.inStoreHours, 4);
  assert.equal(week?.cateringHours, 3);
  assert.equal(week?.marketingHours, 2, "a Catering shift on a marketing deal is marketing work");
  assert.equal(week?.marketingHourlyCost, 30);
});

// ---- Labor vs target (bj-finance #696) ------------------------------------------------------

const SEPT_WEEK = ["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"];

function seedLaborTarget() {
  // Invented: payroll 25% of 100,000; taxes and comp 25% of wages; nobody salaried.
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
  // Each day 10 hours and 160 paid (as PostgREST sends numerics: strings), 200 with taxes and comp; sales 600 in-store + 100 delivery a day.
  db.tables.labor_daily_actuals = SEPT_WEEK.map((day) => ({
    day, hours: "10.00", wages: "150.00", catering_premium: "0.00", solo_close: "10.00", catering_hours: "0.00", catering_wages: "0.00", marketing_hours: "0.00", marketing_wages: "0.00", period_start: "2026-08-31", period_end: "2026-09-13", source: "punches", built_by: "test", updated_at: "2026-09-15T00:00:00Z",
  }));
  db.tables.sales_daily_in_store = SEPT_WEEK.map((day) => ({ day, in_store: "600.00", delivery: "100.00", basis: "booked", source: "square" }));
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
  assert.equal(first.inStoreSales, 4_200);
  assert.equal(first.deliverySales, 700);
  assert.equal(first.cateringSales, 0);
  assert.equal(first.hourly, 1_400);
  assert.equal(first.salaried, 0);
  assert.equal(first.actual, 1_400);
  assert.equal(first.targetPct.value, 0.25);
  assert.equal(first.varianceDollars, 1_400 - 1_225);
  // No payroll on file for the next week: not available, never zero.
  assert.equal(second.available, false);
  assert.equal(second.actual, null);
  assert.deepEqual(second.why, ["hourly payroll on file for 0 of 7 days", "in-store sales on file for 0 of 7 days"]);
});

/** The seeded labor day `day`, changed. */
function laborDay(day: string, over: Record<string, unknown>) {
  const rows = db.tables.labor_daily_actuals as Record<string, unknown>[];
  Object.assign(rows.find((r) => r.day === day)!, over);
}

test("labor vs target: the catering work recorded on a day counts, premium and all, all-in", async () => {
  seedLaborTarget();
  // Invented: Tuesday the 8th, 4 of its 10 hours catering, paid 60 and 20 of premium (as PostgREST sends numerics).
  laborDay("2026-09-08", { catering_hours: "4.00", catering_wages: "60.00", catering_premium: "20.00" });
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.deepEqual(data.problems, []);
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, true, first.why.join("; "));
  assert.equal(first.cateringHours, 4);
  assert.equal(first.cateringCost, 100);
  assert.equal(first.actual, 1_425); // the 20 of premium x 1.25 on top; the 60 of wages was always in the 150
  assert.equal(first.varianceDollars, 1_425 - 1_225);
});

test("labor vs target: the marketing work recorded on a day comes off at what it was paid, all-in", async () => {
  seedLaborTarget();
  // Invented: Tuesday the 8th, 4 of its 10 hours marketing, paid 60 (as PostgREST sends numerics).
  laborDay("2026-09-08", { marketing_hours: "4.00", marketing_wages: "60.00" });
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.deepEqual(data.problems, []);
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, true, first.why.join("; "));
  assert.equal(first.marketingHours, 4);
  assert.equal(first.marketingOffset, 75);
  assert.equal(first.cateringHours, 0);
  assert.equal(first.actual, 1_325);
});

test("labor vs target: a day the marketing split has not reached reads n/a, never zero", async () => {
  seedLaborTarget();
  laborDay("2026-09-08", { marketing_hours: null, marketing_wages: null });
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, false);
  assert.deepEqual(first.why, ["catering and marketing work not yet split out of the payroll for 1 of 7 days"]);
});

test("labor vs target: booked deals add their sales on the event day and never the labor, a deal with no billed crew hours or a drop-off with no crew included", async () => {
  seedLaborTarget();
  db.tables.control_settings.push({
    id: 8, key: "rule.catering_premium", value: 5, detail: { cap_rate: null }, effective_from: "2026-01-01", review_by: "2027-12-31", source: "invented", method: null, recorded_by: null, recorded_at: "2026-01-01T00:00:00Z",
  });
  db.tables.deals.push(
    deal({ id: 3, event_date: "2026-09-08", labor_hours: "5", staff_count: 2 }),
    deal({ id: 4, event_date: "2026-09-09", labor_hours: null, staff_count: null }),
    deal({ id: 5, event_date: "2026-09-10", labor_hours: "6.5", staff_count: 0 }),
  );
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, true, first.why.join("; "));
  assert.equal(first.cateringSales, 3_000); // 1,000 before tax each, by event date
  assert.equal(first.sales, 7_900);
  assert.equal(first.cateringHours, 0);
  assert.equal(first.actual, 1_400);
  assert.equal(first.targetDollars, 7_900 * 0.25);
});

test("labor vs target: a day from before migration 61 (delivery null) reads n/a for its week, never as zero delivery", async () => {
  seedLaborTarget();
  const rows = db.tables.sales_daily_in_store as Record<string, unknown>[];
  rows.find((r) => r.day === "2026-09-10")!.delivery = null;
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, false);
  assert.equal(first.sales, null);
  assert.deepEqual(first.why, ["delivery sales on file for 6 of 7 days"]);
});

test("deals are read from the earlier of the page's first month and Labor vs target's first week", () => {
  assert.equal(dealsFrom("2026-10-10"), "2025-11-01"); // the page's twelve months reach further back
  assert.equal(dealsFrom("2028-06-01"), "2026-05-03"); // the first week under Withers is earlier
});

test("labor vs target: a day bj-finance has not split yet reads n/a for its week, never zero", async () => {
  seedLaborTarget();
  laborDay("2026-09-09", { catering_hours: null, catering_wages: null });
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const first = data.laborTarget!.weeks.find((w) => w.start === "2026-09-06")!;
  assert.equal(first.available, false);
  assert.equal(first.actual, null);
  assert.ok(first.why.includes("catering and marketing work not yet split out of the payroll for 1 of 7 days"), first.why.join("; "));
});

// A past week is judged by the board as it stood that week (bj-finance #696):
// live, every week read n/a because today's board was applied to it.

test("labor vs target: a week's fixed payroll is the people salaried that week, hired later out and archived later in", async () => {
  seedLaborTarget();
  // Invented: one salaried person hired Oct 1 (their only salary row starts then), one archived Oct 1 on 10,000 a year:
  // 12,500 a year with taxes and comp, a 365th of it a day.
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
  assert.ok(Math.abs(first.salaried! - (7 * 12_500) / 365) < 1e-9, String(first.salaried));
  assert.ok(Math.abs(first.actual! - (1_400 + (7 * 12_500) / 365)) < 1e-9, String(first.actual));
  assert.equal(first.targetPct.value, 0.25); // the payroll target, whoever is salaried
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

test("labor hours planning reads seasons, the events in force and last year's hours (migration 47)", async () => {
  const days = [0, 1, 2, 3, 4, 5, 6];
  db.tables.store_hours = days.map((weekday) => ({ weekday, is_closed: false, opens: "10:00:00", closes: "21:00:00" }));
  // From Wednesday Oct 7: 13:00 to 21:00.
  db.tables.store_hours_seasons = days.map((weekday) => ({ effective_from: "2026-10-07", weekday, name: "Test season", is_closed: false, opens: "13:00:00", closes: "21:00:00" }));
  db.tables.concession_events = [
    rev({ id: 1, event_key: "test-expo", name: "Test Expo", start_date: "2026-10-12", end_date: "2026-10-13", expected_net_sales: "100.00", provisional: false }),
    rev({ id: 2, event_key: "test-expo", name: "Test Expo", start_date: "2026-10-05", end_date: "2026-10-06", expected_net_sales: "200.00", provisional: true, effective_from: "2026-09-15" }),
    rev({ id: 3, event_key: "test-fair", name: "Test Fair", start_date: "2026-10-05", end_date: "2026-10-05", expected_net_sales: "50.00", provisional: false, cancelled: true }),
    // Last year's show: its day leaves last year's catering as it is read.
    rev({ id: 4, event_key: "test-show", name: "Test Show", start_date: "2025-10-09", end_date: "2025-10-09", expected_net_sales: "10.00", provisional: false }),
  ];
  // Raw catering hours, and one day marked marketing.
  const hours: Record<string, [string, string]> = { "2025-10-07": ["6.00", "catering"], "2025-10-08": ["20.00", "marketing"], "2025-10-09": ["4.00", "catering"] };
  db.tables.catering_hours_history = ["2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08", "2025-10-09", "2025-10-10", "2025-10-11"].map((day) => ({
    day, hours: hours[day]?.[0] ?? "0.00", kind: hours[day]?.[1] ?? "catering", shifts: 0, source: "when_i_work", built_by: "test", updated_at: NOW.toISOString(),
  }));
  // A marketing deal this week with a Marketing shift of 3 hours, and a Marketing shift with no deal of 2.
  db.tables.deals.push({ ...deal({ id: 7, event_date: "2026-10-08", labor_hours: "5", staff_count: 2 }), event_type: "Marketing Event", stage: "Closed Marketing Event" });
  db.tables.shifts.push(
    { id: 21, employee_id: null, starts_at: "2026-10-08T14:00:00Z", ends_at: "2026-10-08T17:00:00Z", position: "Marketing", deal_id: 7 },
    { id: 22, employee_id: null, starts_at: "2026-10-09T14:00:00Z", ends_at: "2026-10-09T16:00:00Z", position: "Marketing", deal_id: null },
  );
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const week = data.laborPlanning?.weeks[0];
  assert.equal(week?.start, "2026-10-04");
  assert.equal(week?.coverageHours.value, 3 * 11 + 4 * 8, "the season from its first day");
  assert.equal(week?.concessionSales, 200, "the revision in force; the cancelled event is gone");
  assert.deepEqual(week?.events, ["Test Expo (placeholder)"]);
  assert.equal(week?.lastYearCatering, 6, "the marketing day and the show day are not catering");
  assert.equal(week?.estimatedHours.value, 6);
  assert.equal(week?.lastYearMarketing, 20);
  assert.equal(week?.marketingBookedHours, 3 + 2);
  assert.equal(week?.marketingEstimatedHours.value, 15);
  assert.ok(week?.notes.some((n) => n.includes("#1")), "the booked deal with no billed crew hours is named");
});

test("labor hours planning before migration 47: the weekly hours, no events, and the estimate waits, saying why", async () => {
  db.tables.store_hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_closed: false, opens: "10:00:00", closes: "21:00:00" }));
  db.missingTables = ["store_hours_seasons", "concession_events", "catering_hours_history"];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  const week = data.laborPlanning?.weeks[0];
  assert.equal(week?.coverageHours.value, 7 * 11);
  assert.deepEqual(week?.events, []);
  assert.equal(week?.estimatedHours.value, null);
  assert.ok(data.problems.includes("labor hours planning: last year's catering hours are not loaded yet (migration 47)"));
});

// ---- The bookkeeping pass history (bj-finance #937, migration 56) ------------------

test("the pass history reads every pass's runs of the last few months, oldest first", async () => {
  db.tables.bookkeeping_pass_runs = [
    { id: 1, run_date: "2026-06-01", pass_code: "DAILY-02", run_label: "", attended: false, posted_count: 1, posted_dollars: "10.00", queue_before: 2, queue_after: 1, cash: null, issues_filed: [], note: "too old", source: "backfill" },
    { id: 3, run_date: "2026-10-09", pass_code: "WEEKLY-02", run_label: "", attended: false, posted_count: null, posted_dollars: null, queue_before: null, queue_after: null, cash: null, issues_filed: [], note: "sales vs targets sent", source: "pass" },
    { id: 2, run_date: "2026-10-09", pass_code: "DAILY-02", run_label: "", attended: false, posted_count: 3, posted_dollars: "2017.80", queue_before: 13, queue_after: 10, cash: null, issues_filed: [846], note: "3 posted", source: "pass" },
    { id: 4, run_date: "2026-09-15", pass_code: "DAILY-02", run_label: "", attended: true, posted_count: 1, posted_dollars: "45.00", queue_before: 5, queue_after: 4, cash: null, issues_filed: [], note: "written late", source: "backfill" },
  ];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.equal(data.passRuns.status, "ok");
  if (data.passRuns.status !== "ok") return;
  assert.deepEqual(
    data.passRuns.runs.map((r) => `${r.runDate} ${r.passCode} ${r.postedDollars}`),
    ["2026-09-15 DAILY-02 45", "2026-10-09 DAILY-02 2017.8", "2026-10-09 WEEKLY-02 null"],
  );
  assert.deepEqual(data.problems, []);
});

test("before migration 56 the pass history is not set up, which is not a problem to report", async () => {
  db.missingTables = ["bookkeeping_pass_runs"];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.deepEqual(data.passRuns, { status: "not_enabled" });
  assert.deepEqual(data.problems, []);
});

test("a pass history read that is refused is unreadable and says why, never an empty history", async () => {
  const client = managerClient((url) =>
    url.pathname.endsWith("/bookkeeping_pass_runs") ? refusal(403, "42501", "permission denied for table bookkeeping_pass_runs") : undefined,
  );
  const data = buildMetricsData(await loadMetricsInputs(client, NOW));
  assert.deepEqual(data.passRuns, { status: "unreadable", message: "permission denied for table bookkeeping_pass_runs" });
});
