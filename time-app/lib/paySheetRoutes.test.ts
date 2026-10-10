// The pay table's two doors (bj-finance #519, Alina 2026-10-05): the Rebuild
// button (POST /api/payroll/sheet) records a request for the Mac to build, and
// Submit (POST /api/payroll/submit) is refused until the period's pay table is
// built, has no open items and is newer than the latest change to the period.
// The database's copy of the gate is supabase/migration_36_verify.sql.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request) => Promise<Response>;

const sheetRoute = await loadAppModule<{ GET: Handler; POST: Handler }>("app/api/payroll/sheet/route.ts");
const submitRoute = await loadAppModule<{ POST: Handler }>("app/api/payroll/submit/route.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
// A period that has ended (submittal opens the day after window_end).
const WINDOW_END = "2026-09-20";
const STARTED = "2026-09-22T15:00:00.000000+00:00";

function post(path: string, body: unknown): Request {
  return new Request(`http://time.test/api/payroll/${path}`, { method: "POST", body: JSON.stringify(body) });
}

function builtSheet(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    window_end: WINDOW_END,
    status: "built",
    requested_by: MANAGER,
    requested_at: STARTED,
    started_at: STARTED,
    built_at: "2026-09-22T15:01:00.000000+00:00",
    built_by: "test",
    source_fingerprint: "f",
    open_items: 0,
    error: null,
    sheet: { open_items: [] },
    ...over,
  };
}

let db: FakeSupabase;

function start(tables: Record<string, Record<string, unknown>[]> = {}) {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: false, full_name: "Test Owner" },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee" },
    ],
    payroll_sheets: [],
    payroll_run_submittals: [],
    row_audit: [],
    payroll_rulings: [],
    ...tables,
  });
}

beforeEach(() => start());

// ---------- Rebuild pay table -----------------------------------------------------

test("Rebuild queues a request in the manager's name and answers with it queued", async () => {
  db.signIn(MANAGER);
  const res = await sheetRoute.POST(post("sheet", { window_end: WINDOW_END }));
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.available, true);
  assert.equal(state.built, null);
  assert.equal(state.latest.status, "queued");
  assert.equal(state.latest.requested_by, MANAGER);
  assert.deepEqual(
    db.rows("payroll_sheets").map((r) => [r.window_end, r.status, r.requested_by]),
    [[WINDOW_END, "queued", MANAGER]],
  );
});

test("Rebuild is refused to a staff member and queues nothing", async () => {
  db.signIn(SAM);
  const res = await sheetRoute.POST(post("sheet", { window_end: WINDOW_END }));
  assert.equal(res.status, 403);
  assert.deepEqual(db.rows("payroll_sheets"), []);
});

test("Rebuild for a day that ends no pay period is refused and queues nothing", async () => {
  db.signIn(MANAGER);
  const res = await sheetRoute.POST(post("sheet", { window_end: "2026-09-21" }));
  assert.equal(res.status, 400);
  assert.deepEqual(db.rows("payroll_sheets"), []);
});

test("before migration 36, Rebuild says the migration is needed", async () => {
  db.missingTables.push("payroll_sheets");
  db.signIn(MANAGER);
  const res = await sheetRoute.POST(post("sheet", { window_end: WINDOW_END }));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /needs migration 36/);
});

test("before migration 36, reading the pay table answers 'not available' rather than failing", async () => {
  db.missingTables.push("payroll_sheets");
  db.signIn(MANAGER);
  const res = await sheetRoute.GET(new Request(`http://time.test/api/payroll/sheet?window_end=${WINDOW_END}`));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { available: false, reason: "it needs migration 36 in Supabase." });
});

test("reading the pay table returns the period's latest build, its latest request and how many builds are kept", async () => {
  start({
    payroll_sheets: [
      builtSheet({ id: 1, window_end: "2026-10-04", built_at: "2026-10-06T15:00:00.000000+00:00" }),
      builtSheet({ id: 2 }),
      builtSheet({ id: 3, built_at: "2026-09-22T15:30:00.000000+00:00" }),
      { ...builtSheet({ id: 4, status: "queued", requested_at: "2026-09-22T16:00:00.000000+00:00" }), started_at: null, built_at: null, sheet: null },
    ],
  });
  db.signIn(MANAGER);
  const res = await sheetRoute.GET(new Request(`http://time.test/api/payroll/sheet?window_end=${WINDOW_END}`));
  const state = await res.json();
  assert.equal(state.available, true);
  assert.equal(state.built.id, 3);
  assert.equal(state.latest.id, 4);
  assert.equal(state.latest.status, "queued");
  assert.equal(state.builds, 2);
  assert.equal(state.changedAt, null);
});

// ---------- Submit's pay-table gate -----------------------------------------------

async function submit() {
  db.signIn(MANAGER);
  const res = await submitRoute.POST(post("submit", { window_end: WINDOW_END }));
  return { status: res.status, body: await res.json() };
}

test("Submit is refused until a pay table is built for the period", async () => {
  const { status, body } = await submit();
  assert.equal(status, 409);
  assert.match(body.error, /Build the pay table for this period first/);
  assert.deepEqual(db.rows("payroll_run_submittals"), []);
});

test("Submit is refused while the pay table has open items", async () => {
  start({ payroll_sheets: [builtSheet({ open_items: 3 })] });
  const { status, body } = await submit();
  assert.equal(status, 409);
  assert.match(body.error, /3 open items/);
  assert.deepEqual(db.rows("payroll_run_submittals"), []);
});

test("Submit is refused when a punch in the period changed after the pay table was built", async () => {
  start({
    payroll_sheets: [builtSheet()],
    row_audit: [
      {
        id: 1,
        table_name: "time_entries",
        row_id: 9,
        op: "UPDATE",
        at: "2026-09-22T16:00:00.000000+00:00",
        actor_uid: MANAGER,
        actor_role: "manager",
        db_role: "authenticated",
        before_image: { clock_in_at: "2026-09-15T14:00:00+00:00" },
        after_image: { clock_in_at: "2026-09-15T14:30:00+00:00" },
      },
    ],
  });
  const { status, body } = await submit();
  assert.equal(status, 409);
  assert.match(body.error, /changed at .* after the pay table was built/);
  assert.deepEqual(db.rows("payroll_run_submittals"), []);
});

test("Submit is refused when a choice for the period was made after the pay table was built", async () => {
  start({
    payroll_sheets: [builtSheet()],
    payroll_rulings: [
      { window_end: WINDOW_END, case_date: "2026-09-12", decided_at: "2026-09-22T16:00:00.000000+00:00", created_at: "2026-09-22T16:00:00.000000+00:00" },
    ],
  });
  const { status, body } = await submit();
  assert.equal(status, 409);
  assert.match(body.error, /after the pay table was built/);
});

test("Submit goes through with a fresh pay table that has no open items", async () => {
  start({
    payroll_sheets: [builtSheet()],
    row_audit: [
      // Before the build: already in it.
      {
        id: 1,
        table_name: "time_entries",
        row_id: 9,
        op: "INSERT",
        at: "2026-09-21T16:00:00.000000+00:00",
        actor_uid: MANAGER,
        actor_role: "manager",
        db_role: "authenticated",
        before_image: null,
        after_image: { clock_in_at: "2026-09-15T14:00:00+00:00" },
      },
    ],
  });
  const { status, body } = await submit();
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(
    db.rows("payroll_run_submittals").map((r) => [r.window_end, r.submitted_by]),
    [[WINDOW_END, MANAGER]],
  );
});
