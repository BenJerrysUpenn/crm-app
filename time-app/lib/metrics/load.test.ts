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
  assert.deepEqual(data.problems, ["people: column profiles.pay_type does not exist"]);
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
  assert.deepEqual(data.problems.map((p) => p.split(":")[0]).sort(), ["outreach", "shifts"]);
  assert.equal(data.catering?.byDay["2026-10-04"], 1000);
});

test("when the deals cannot load, every deal-based widget is null rather than empty", async () => {
  db.missingTables = ["deals"];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.equal(data.catering, null);
  assert.equal(data.ar, null);
  assert.equal(data.leads, null);
  assert.equal(data.quotes, null);
  assert.deepEqual(data.problems.map((p) => p.split(":")[0]).sort(), ["catering deals", "new enquiries"]);
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

test("labor vs target: each week of the last full month by default, from the paid actuals, the daily sales and the board", async () => {
  seedLaborTarget();
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.deepEqual(data.problems, []);
  assert.equal(data.laborTarget?.defaultMonth, "2026-09");
  assert.equal(data.laborTarget?.months[0].month, "2026-10");
  const sept = data.laborTarget?.months.find((m) => m.month === "2026-09");
  assert.deepEqual(sept?.weeks.map((w) => w.start), ["2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27"]);
  const [first, second] = sept!.weeks;
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

test("labor vs target: when the paid actuals cannot be read the card cannot load and says so; the rest still draws", async () => {
  seedLaborTarget();
  db.missingTables = ["labor_daily_actuals"];
  const data = buildMetricsData(await loadMetricsInputs(managerClient(), NOW));
  assert.equal(data.laborTarget, null);
  assert.deepEqual(data.problems.map((p) => p.split(":")[0]), ["labor vs target"]);
  assert.equal(data.catering?.byDay["2026-10-04"], 1000);
});
