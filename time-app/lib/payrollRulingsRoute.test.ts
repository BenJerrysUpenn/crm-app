// The payroll rulings route across the 2026-10-05 cutover (ruled 2026-10-05):
// from the period starting CREW_PUNCH_REQUIRED_FROM there is no solo-close
// dropdown (1.9) and no crewless-tip picker (3.5), so POST refuses those
// choices; the stranded-Olo picker (3.7) and every earlier period are
// unchanged, and clearing an old choice (DELETE) is still allowed.
// POST/DELETE /api/payroll/rulings.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request) => Promise<Response>;

const route = await loadAppModule<{ POST: Handler; DELETE: Handler }>("app/api/payroll/rulings/route.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const STAFF = "00000000-0000-0000-0000-00000000000b";

/** The first period from the cutover, 2026-10-05..10-18, and the one before it. */
const AFTER_END = "2026-10-18";
const BEFORE_END = "2026-10-04";

function post(body: unknown): Request {
  return new Request("http://time.test/api/payroll/rulings", { method: "POST", body: JSON.stringify(body) });
}

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Test Manager" },
      { id: STAFF, role: "employee", active: true, full_name: "Test Staff" },
    ],
    payroll_rulings: [],
  });
  db.signIn(MANAGER);
});

test("rulings: from 2026-10-05 a solo-close (1.9) choice is refused, pointing at the punch to add", async () => {
  const res = await route.POST(post({ window_end: AFTER_END, check_id: "1.9", finding_key: "1.9:2026-10-07", choice: "skip" }));
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /punch/);
  assert.equal(db.rows("payroll_rulings").length, 0);
});

test("rulings: from 2026-10-05 a crewless-tip (3.5) payee is refused", async () => {
  const res = await route.POST(
    post({ window_end: AFTER_END, check_id: "3.5", finding_key: "3.5:deal:25300", choice: "staff", payee_id: STAFF }),
  );
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /punch/);
  assert.equal(db.rows("payroll_rulings").length, 0);
});

test("rulings: from 2026-10-05 a stranded-Olo (3.7) payee is still recorded", async () => {
  const res = await route.POST(
    post({ window_end: AFTER_END, check_id: "3.7", finding_key: "3.7:2026-10-18", choice: "staff", payee_id: STAFF }),
  );
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(db.rows("payroll_rulings").length, 1);
  assert.equal(db.rows("payroll_rulings")[0].payee_id, STAFF);
});

test("rulings: before 2026-10-05 a solo-close (1.9) choice is still recorded", async () => {
  const res = await route.POST(post({ window_end: BEFORE_END, check_id: "1.9", finding_key: "1.9:2026-09-23", choice: "skip" }));
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(
    db.rows("payroll_rulings").map((r) => [r.check_id, r.finding_key, r.choice, r.window_end]),
    [["1.9", "1.9:2026-09-23", "skip", BEFORE_END]],
  );
});

test("rulings: from 2026-10-05 an old 1.9 choice can still be cleared", async () => {
  db.tables.payroll_rulings.push({ id: 1, window_end: AFTER_END, check_id: "1.9", finding_key: "1.9:2026-10-07", choice: "skip" });
  const qs = new URLSearchParams({ window_end: AFTER_END, check_id: "1.9", finding_key: "1.9:2026-10-07" });
  const res = await route.DELETE(new Request(`http://time.test/api/payroll/rulings?${qs}`, { method: "DELETE" }));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(db.rows("payroll_rulings").length, 0);
});
