// Payroll's timesheet checks read the store-hours seasons too (migration 47,
// bj-finance #742): from a season's first day, the mid-day coverage check
// (§1.8) judges the punches against the season's hours, not the weekly
// pattern. Drives GET /api/payroll/verify against the stand-in Supabase
// (testing/fakeSupabase.ts). Invented people, dates and hours only.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

const verify = await loadAppModule<{ GET: (request: Request) => Promise<Response> }>("app/api/payroll/verify/route.ts");

const MANAGER = "00000000-0000-0000-0000-0000000000b1";
// The period 2026-09-21 to 2026-10-04 (Monday to Sunday, two weeks).
const WINDOW_END = "2026-10-04";
const SEASON_FROM = "2026-09-28";
const SEASON_DAYS = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];

type Finding = { check: string; key: string; summary: string };

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [{ id: MANAGER, role: "manager", active: true, full_name: "Store Manager" }],
    // The weekly pattern: closed every day, so only a season can open the store.
    store_hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_closed: true, opens: null, closes: null, updated_at: "2026-01-01T00:00:00Z" })),
    store_hours_exceptions: [],
    store_hours_seasons: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      effective_from: SEASON_FROM, weekday, name: "Test season", is_closed: false, opens: "13:00:00", closes: "21:00:00",
    })),
    time_entries: [],
    shifts: [],
  });
  db.signIn(MANAGER);
});

async function coverageFindings(): Promise<Finding[]> {
  const res = await verify.GET(new Request(`http://finance.test/api/payroll/verify?window_end=${WINDOW_END}`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { findings: Finding[] };
  return body.findings.filter((f) => f.check === "1.8");
}

test("from a season's first day the coverage check judges the day against the season's hours", async () => {
  const keys = (await coverageFindings()).map((f) => f.key).sort();
  assert.deepEqual(keys, SEASON_DAYS.map((d) => `1.8:${d}:13:00-21:00`));
});

test("before migration 47 the weekly pattern stands", async () => {
  db.missingTables.push("store_hours_seasons");
  assert.deepEqual(await coverageFindings(), []);
});

test("a failed seasons read leaves every day unjudged, never judged on the weekly pattern alone", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/v1/store_hours_seasons") return new Response(JSON.stringify({ message: "timeout" }), { status: 500 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const found = await coverageFindings();
    assert.deepEqual(found.map((f) => f.key), [`1.8:hours-not-set:${WINDOW_END}`]);
    assert.match(found[0].summary, /^14 days in this window have no store hours set/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
