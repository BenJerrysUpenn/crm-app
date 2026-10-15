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
const { loadBoard, NEEDS_MIGRATION } = await loadAppModule<LoadModule>("lib/controlBoard/load.ts");
const { createClient } = await loadAppModule<{ createClient: () => SupabaseClient }>("lib/supabase/server.ts");

const TODAY = "2030-10-14";
const MANAGER = "00000000-0000-0000-0000-0000000000b1";
const NOTE = { review_by: "2031-01-01", source: "invented", method: null, recorded_by: MANAGER, recorded_at: "2030-01-01T00:00:00Z" };

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Store Manager", pay_type: "hourly" },
      { id: "p-zed", role: "manager", active: true, full_name: "Zed Salaried", pay_type: "salaried" },
      { id: "p-amy", role: "employee", active: true, full_name: "Amy Salaried", pay_type: "salaried" },
      { id: "p-old", role: "manager", active: false, full_name: "Gone Salaried", pay_type: "salaried" },
      { id: "p-nameless", role: "employee", active: true, full_name: null, pay_type: "salaried" },
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

test("a manager gets the stored values as numbers, the active salaried staff by name, and the trend's two months", async () => {
  const board = await loadBoard(createClient(), TODAY);
  assert.ok(board.ready);
  assert.equal(board.settings[0].value, 0.3);
  assert.deepEqual(board.settings[0].detail, {}, "a null detail reads as no detail");
  assert.equal(board.salaries[0].annual_salary, 50_000);
  assert.deepEqual(
    board.salaried,
    [
      { id: "p-amy", name: "Amy Salaried" },
      { id: "p-zed", name: "Zed Salaried" },
      { id: "p-nameless", name: "Unnamed" },
    ],
    "active and salaried only, by name",
  );
  assert.deepEqual(
    board.monthly.map((m) => [m.month, m.in_store]).sort(),
    [["2029-09-01", 10_000], ["2030-09-01", 9_000]],
    "last full month and the same month a year earlier",
  );
  assert.deepEqual(board.problems, []);
});

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
