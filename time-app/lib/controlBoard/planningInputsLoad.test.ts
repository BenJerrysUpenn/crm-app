// What the Targets tab's planning inputs read (bj-finance #742):
// loadPlanningInputs() drives the real supabase-js client against the
// stand-in Supabase project (testing/fakeSupabase.ts), as the signed-in
// manager. Before migration 47 it says so and closed days still read.
// Invented figures only.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAppModule, startFakeSupabase, type FakeSupabase } from "../testing/fakeSupabase.ts";

type LoadModule = typeof import("./planningInputsLoad.ts");
const { loadPlanningInputs } = await loadAppModule<LoadModule>("lib/controlBoard/planningInputsLoad.ts");
const { createClient } = await loadAppModule<{ createClient: () => SupabaseClient }>("lib/supabase/server.ts");

const TODAY = "2030-10-14";
const MANAGER = "00000000-0000-0000-0000-0000000000b1";
const NOTE = { review_by: "2031-01-01", source: "invented", method: null, recorded_by: null, recorded_at: "2030-01-01T00:00:00Z", cancelled: false };

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [{ id: MANAGER, role: "manager", active: true, full_name: "Store Manager" }],
    store_hours_seasons: [
      { effective_from: "2030-11-01", weekday: 0, name: "Test winter", is_closed: false, opens: "13:00:00", closes: "21:00:00", review_by: null, source: null, method: null },
    ],
    // PostgREST returns numeric columns as strings.
    concession_events: [
      { id: 1, event_key: "test-expo-2030", name: "Test Expo", start_date: "2030-12-01", end_date: "2030-12-02", expected_net_sales: "300.50", provisional: true, effective_from: "2030-01-01", ...NOTE },
    ],
    store_hours_exceptions: [
      { date: "2030-10-13", label: "Yesterday", is_closed: true, opens: null, closes: null, created_at: null },
      { date: "2030-11-28", label: "Test holiday", is_closed: true, opens: null, closes: null, created_at: null },
    ],
  });
  db.signIn(MANAGER);
});

test("the inputs read as numbers, and closed days from today on", async () => {
  const d = await loadPlanningInputs(createClient(), TODAY);
  assert.equal(d.unavailable, null);
  assert.deepEqual(d.problems, []);
  assert.equal(d.seasons.length, 1);
  assert.equal(d.concession[0].expected_net_sales, 300.5);
  assert.deepEqual(d.exceptions.map((e) => e.date), ["2030-11-28"]);
});

test("the open-up and close-down minutes are read for the seasons' staffed hours, as numbers, and no other board value", async () => {
  db.tables.control_settings = [
    { id: 1, key: "staffing.open_up_minutes", value: "20", detail: {}, effective_from: "2030-01-01", ...NOTE },
    { id: 2, key: "staffing.close_down_minutes", value: "10", detail: {}, effective_from: "2030-01-01", ...NOTE },
    { id: 3, key: "target.payroll_pct", value: "0.5", detail: {}, effective_from: "2030-01-01", ...NOTE },
  ];
  const d = await loadPlanningInputs(createClient(), TODAY);
  assert.deepEqual(d.staffing.map((r) => [r.key, r.value]), [["staffing.open_up_minutes", 20], ["staffing.close_down_minutes", 10]]);
  assert.deepEqual(d.problems, []);
});

test("before migration 43 there are no minutes, and nothing is wrong", async () => {
  db.missingTables.push("control_settings");
  const d = await loadPlanningInputs(createClient(), TODAY);
  assert.deepEqual(d.staffing, []);
  assert.deepEqual(d.problems, []);
});

test("a failed read of the minutes is named as a problem, and the seasons still read", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/v1/control_settings") return new Response(JSON.stringify({ message: "timeout" }), { status: 500 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const d = await loadPlanningInputs(createClient(), TODAY);
    assert.deepEqual(d.staffing, []);
    assert.deepEqual(d.problems, ["Open-up and close-down minutes could not be read: timeout"]);
    assert.equal(d.seasons.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("before migration 47 the seasons and events say they need it; closed days still read", async () => {
  db.missingTables.push("store_hours_seasons", "concession_events");
  const d = await loadPlanningInputs(createClient(), TODAY);
  assert.match(d.unavailable ?? "", /migration 47/);
  assert.deepEqual([d.seasons, d.concession], [[], []]);
  assert.deepEqual(d.problems, []);
  assert.deepEqual(d.exceptions.map((e) => e.date), ["2030-11-28"]);
});
