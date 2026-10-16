// What the Targets page reads (bj-finance #693): loadBoard() drives the real
// supabase-js client against the stand-in Supabase project
// (testing/fakeSupabase.ts), as the signed-in manager. Before migration 43 it
// says so instead of an empty board; a sales-history read that fails is
// reported and the board still draws. Invented figures only.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAppModule, startFakeSupabase, type FakeSupabase } from "../testing/fakeSupabase.ts";

type LoadModule = typeof import("./load.ts");
const { loadBoard, loadSalaries, NEEDS_MIGRATION } = await loadAppModule<LoadModule>("lib/controlBoard/load.ts");
const { createClient } = await loadAppModule<{ createClient: () => SupabaseClient }>("lib/supabase/server.ts");

const TODAY = "2030-10-14";
const MANAGER = "00000000-0000-0000-0000-0000000000b1";
const NOTE = { review_by: "2031-01-01", source: "invented", method: null, recorded_by: MANAGER, recorded_at: "2030-01-01T00:00:00Z" };

let db: FakeSupabase;

// A read the database refuses for a reason other than a missing table (a
// policy refusal, as PostgREST answers one). Everything else goes on to the
// fake project.
function refuseReadsOf(table: string) {
  const project = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "GET" && new URL(request.url).pathname === `/rest/v1/${table}`) {
      return Response.json({ code: "42501", details: null, hint: null, message: `permission denied for table ${table}` }, { status: 403 });
    }
    return project(request);
  }) as typeof fetch;
}

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      // is_overhead is NOT NULL DEFAULT false in the database (migration 45).
      { id: MANAGER, role: "manager", active: true, full_name: "Store Manager", pay_type: "hourly", is_overhead: false },
      { id: "p-zed", role: "manager", active: true, full_name: "Zed Salaried", pay_type: "salaried", is_overhead: false },
      { id: "p-amy", role: "employee", active: true, full_name: "Amy Salaried", pay_type: "salaried", is_overhead: false },
      { id: "p-old", role: "manager", active: false, full_name: "Gone Salaried", pay_type: "salaried", archived_at: "2030-10-04T12:00:00Z", is_overhead: false },
      { id: "p-off", role: "manager", active: false, full_name: "Off Schedule Salaried", pay_type: "salaried", archived_at: null, is_overhead: false },
      { id: "p-hourly", role: "employee", active: false, full_name: "Off Schedule Hourly", pay_type: "hourly", archived_at: null, is_overhead: false },
      { id: "p-nameless", role: "employee", active: true, full_name: null, pay_type: "salaried", is_overhead: false },
      { id: "p-overhead", role: "manager", active: true, full_name: "Overhead Salaried", pay_type: "salaried", archived_at: null, is_overhead: true },
    ],
    // PostgREST returns numeric columns as strings.
    control_settings: [{ id: 1, key: "target.payroll_pct", value: "0.3", detail: null, effective_from: "2030-01-01", ...NOTE }],
    profile_salaries: [{ id: 1, profile_id: "p-zed", annual_salary: "50000.00", effective_from: "2030-01-01", ...NOTE }],
    sales_monthly: [
      { month: "2030-09-01", source: "qbo", in_store: "9000.00" },
      { month: "2029-09-01", source: "seller", in_store: "10000.00" },
      { month: "2030-08-01", source: "qbo", in_store: "1.00" },
    ],
    sales_daily_in_store: [],
  });
  db.signIn(MANAGER);
});

test("before migration 43 the board says it needs the migration instead of drawing an empty board", async () => {
  db.missingTables.push("control_settings", "profile_salaries");
  assert.deepEqual(await loadBoard(createClient(), TODAY), { ready: false, reason: NEEDS_MIGRATION });
});

test("a manager gets the stored values as numbers, the salaried staff not archived by name, and the trend's two months", async () => {
  const board = await loadBoard(createClient(), TODAY);
  assert.ok(board.ready);
  assert.equal(board.settings[0].value, 0.3);
  assert.deepEqual(board.settings[0].detail, {}, "a null detail reads as no detail");
  assert.equal(board.salaries[0].annual_salary, 50_000);
  assert.deepEqual(
    board.salaried,
    [
      { id: "p-amy", name: "Amy Salaried" },
      { id: "p-off", name: "Off Schedule Salaried" },
      { id: "p-zed", name: "Zed Salaried" },
      { id: "p-nameless", name: "Unnamed" },
    ],
    "salaried, not archived and not overhead, by name; archived, overhead and hourly left out",
  );
  assert.deepEqual(
    board.monthly.map((m) => [m.month, m.in_store]).sort(),
    [["2029-09-01", 10_000], ["2030-09-01", 9_000]],
    "last full month and the same month a year earlier",
  );
  assert.deepEqual(board.problems, []);
});

test("fixed payroll counts a salaried person who is off the schedule but not archived, and never an archived one", async () => {
  const board = await loadBoard(createClient(), TODAY);
  assert.ok(board.ready);
  const ids = board.salaried.map((p) => p.id);
  assert.ok(ids.includes("p-off"), "salaried, not on the schedule (active false), not archived: paid, so counted");
  assert.ok(!ids.includes("p-old"), "archived: gone, left out whatever else is set");
  assert.ok(!ids.includes("p-hourly"), "hourly is not fixed payroll");
});

test("an overhead person is not in fixed payroll, salaried and on the schedule though they are", async () => {
  db.tables.profile_salaries.push({ id: 2, profile_id: "p-overhead", annual_salary: "40000.00", effective_from: "2030-01-01", ...NOTE });
  const board = await loadBoard(createClient(), TODAY);
  assert.ok(board.ready);
  assert.ok(!board.salaried.some((p) => p.id === "p-overhead"), "overhead: not part of the payroll target");
  assert.equal(board.salaried.length, 4, "everyone else salaried and not archived is still counted");
});

test("loadSalaries returns null only before migration 43, so the Team page may read null as 'not set up'", async () => {
  const withTable = await loadSalaries(createClient());
  assert.ok(withTable != null);
  assert.equal(withTable.length, 1);
  assert.equal(withTable[0].profile_id, "p-zed");
  assert.equal(withTable[0].annual_salary, 50_000, "numeric columns arrive as numbers");

  db.missingTables.push("profile_salaries");
  assert.equal(await loadSalaries(createClient()), null, "the missing table is the only null");
});

test("a salary read refused for any other reason throws, so the Team page never mistakes it for 'needs migration 43'", async () => {
  refuseReadsOf("profile_salaries");
  await assert.rejects(loadSalaries(createClient()), /^Error: profile_salaries: permission denied for table profile_salaries$/);
});

for (const [table, said] of [
  ["control_settings", "The settings could not be read: permission denied for table control_settings"],
  ["profile_salaries", "The salaries could not be read: permission denied for table profile_salaries"],
  ["profiles", "The team could not be read: permission denied for table profiles"],
] as const) {
  test(`a refused ${table} read says which read failed instead of drawing a board or asking for the migration`, async () => {
    refuseReadsOf(table);
    assert.deepEqual(await loadBoard(createClient(), TODAY), { ready: false, reason: said });
  });
}

test("when the sales history cannot be read the board still draws and says what failed", async () => {
  db.missingTables.push("sales_monthly", "sales_daily_in_store");
  const board = await loadBoard(createClient(), TODAY);
  assert.ok(board.ready);
  assert.equal(board.problems.length, 2);
  assert.match(board.problems[0], /^Monthly sales could not be read: /);
  assert.match(board.problems[1], /^Daily sales could not be read: /);
  assert.deepEqual(board.monthly, []);
  assert.deepEqual(board.daily, []);
  assert.equal(board.settings.length, 1, "the stored values still load");
});
