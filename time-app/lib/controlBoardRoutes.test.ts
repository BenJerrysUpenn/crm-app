// The control board's two doors (bj-finance #693): POST /api/payroll/targets
// adds a dated value for a board setting, POST /api/payroll/targets/salary a
// dated salary from the Team page. Owners change; every other manager views;
// a change is a new row and never rewrites the old one.
//
// These drive the real route handlers against the stand-in Supabase project
// (testing/fakeSupabase.ts). The database's own policies are proven by
// supabase/migration_43_verify.sql. Invented figures only.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { DB_NOW, loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request) => Promise<Response>;

const targets = await loadAppModule<{ POST: Handler }>("app/api/payroll/targets/route.ts");
const salary = await loadAppModule<{ POST: Handler }>("app/api/payroll/targets/salary/route.ts");

const OWNER = "00000000-0000-0000-0000-0000000000a1";
const MANAGER = "00000000-0000-0000-0000-0000000000b1";
const EMPLOYEE = "00000000-0000-0000-0000-0000000000c1";
const SALARIED = "00000000-0000-0000-0000-0000000000d1";

function post(path: string, body: unknown): Request {
  return new Request(`http://finance.test/api/payroll/${path}`, { method: "POST", body: JSON.stringify(body) });
}

const NOTE = { effective_from: "2030-01-01", review_by: "2031-01-01", source: "invented for the test", method: "by hand" };

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: OWNER, role: "owner", active: false, full_name: "Owner One" },
      { id: MANAGER, role: "manager", active: true, full_name: "Store Manager" },
      { id: EMPLOYEE, role: "employee", active: true, full_name: "Sam Lee", pay_type: "hourly" },
      { id: SALARIED, role: "manager", active: true, full_name: "Pat Doe", pay_type: "salaried" },
    ],
    control_settings: [],
    profile_salaries: [],
  });
});

// ---- the board's settings -----------------------------------------------------------

test("an owner sets a value: it is stored as a new dated row in the owner's name", async () => {
  db.signIn(OWNER);
  const res = await targets.POST(post("targets", { key: "tax.futa", value: 0.01, detail: { wage_cap: 1000 }, ...NOTE }));
  assert.equal(res.status, 200);
  const { setting } = await res.json();
  assert.equal(setting.key, "tax.futa");
  assert.deepEqual(
    db.rows("control_settings").map((r) => [r.key, r.value, r.detail, r.effective_from, r.review_by, r.source, r.method, r.recorded_by, r.recorded_at]),
    [["tax.futa", 0.01, { wage_cap: 1000 }, "2030-01-01", "2031-01-01", "invented for the test", "by hand", OWNER, DB_NOW]],
  );
});

test("changing a value adds a row; the old one stays as history", async () => {
  db.signIn(OWNER);
  await targets.POST(post("targets", { key: "target.payroll_pct", value: 0.3, ...NOTE }));
  const res = await targets.POST(post("targets", { key: "target.payroll_pct", value: 0.25, ...NOTE, effective_from: "2030-06-01" }));
  assert.equal(res.status, 200);
  assert.deepEqual(db.rows("control_settings").map((r) => [r.value, r.effective_from]), [[0.3, "2030-01-01"], [0.25, "2030-06-01"]]);
});

test("a manager who is not an owner cannot change the board, and nothing is written", async () => {
  db.signIn(MANAGER);
  const res = await targets.POST(post("targets", { key: "target.payroll_pct", value: 0.3, ...NOTE }));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Only an owner/);
  assert.equal(db.rows("control_settings").length, 0);
});

test("an employee, or nobody signed in, is refused", async () => {
  db.signIn(EMPLOYEE);
  assert.equal((await targets.POST(post("targets", { key: "target.payroll_pct", value: 0.3, ...NOTE }))).status, 403);
  startFakeSupabase({ profiles: [], control_settings: [] });
  assert.equal((await targets.POST(post("targets", { key: "target.payroll_pct", value: 0.3, ...NOTE }))).status, 403);
});

test("a value that does not fit its setting is refused with the reason", async () => {
  db.signIn(OWNER);
  const cases: [unknown, RegExp][] = [
    [{ key: "target.unknown", value: 0.3, ...NOTE }, /Unknown setting/],
    [{ key: "target.payroll_pct", value: 3, ...NOTE }, /at most 100%/],
    [{ key: "target.payroll_pct", value: 0.3, ...NOTE, source: "" }, /where the value came from/],
    [{ key: "target.payroll_pct", value: 0.3, ...NOTE, review_by: "2029-01-01" }, /review-by date cannot be before/],
    [{ key: "rule.solo_close", value: 5, detail: { min_alone_hours: 4 }, ...NOTE }, /Clocks out at or after is required/],
  ];
  for (const [body, why] of cases) {
    const res = await targets.POST(post("targets", body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, why);
  }
  assert.equal(db.rows("control_settings").length, 0);
});

test("before migration 43 the board answers that it needs the migration", async () => {
  db.missingTables.push("control_settings");
  db.signIn(OWNER);
  const res = await targets.POST(post("targets", { key: "target.payroll_pct", value: 0.3, ...NOTE }));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /migration 43/);
});

// ---- salaries ---------------------------------------------------------------------------

test("an owner sets a salaried person's salary as a dated row", async () => {
  db.signIn(OWNER);
  const res = await salary.POST(post("targets/salary", { profile_id: SALARIED, annual_salary: "1,000", ...NOTE }));
  assert.equal(res.status, 200);
  assert.deepEqual(
    db.rows("profile_salaries").map((r) => [r.profile_id, r.annual_salary, r.effective_from, r.recorded_by]),
    [[SALARIED, 1000, "2030-01-01", OWNER]],
  );
});

test("a salary is only for someone whose Pay is Salaried", async () => {
  db.signIn(OWNER);
  const res = await salary.POST(post("targets/salary", { profile_id: EMPLOYEE, annual_salary: 1000, ...NOTE }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Salaried/);
  const nobody = await salary.POST(post("targets/salary", { profile_id: "00000000-0000-0000-0000-0000000000ff", annual_salary: 1000, ...NOTE }));
  assert.equal(nobody.status, 404);
  assert.equal(db.rows("profile_salaries").length, 0);
});

test("before migration 43 the salary route answers that it needs the migration", async () => {
  db.missingTables.push("profile_salaries");
  db.signIn(OWNER);
  const res = await salary.POST(post("targets/salary", { profile_id: SALARIED, annual_salary: 1000, ...NOTE }));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /migration 43/);
});

test("a manager who is not an owner cannot set a salary, their own included", async () => {
  db.signIn(SALARIED);
  const res = await salary.POST(post("targets/salary", { profile_id: SALARIED, annual_salary: 1000, ...NOTE }));
  assert.equal(res.status, 403);
  assert.equal(db.rows("profile_salaries").length, 0);
});
