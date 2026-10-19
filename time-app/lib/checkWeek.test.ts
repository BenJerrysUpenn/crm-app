// The "Check week" button: the store-coverage check run on demand against the
// live shifts of the week on the board. Managers only, read-only.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";
import { shiftsTouchingWeek } from "./coverage.ts";

type Get = (request: Request) => Promise<Response>;

const checkWeek = await loadAppModule<{ GET: Get }>("app/api/schedule/check-week/route.ts");
const { default: CheckWeekButton } = await loadAppModule<{
  default: (props: { isManager: boolean; weekStart: string }) => unknown;
}>("components/CheckWeekButton.tsx");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const JO = "00000000-0000-0000-0000-00000000000c";
const WEEK = "2026-10-04"; // Sunday
const DATES = Array.from({ length: 7 }, (_, i) => `2026-10-${String(4 + i).padStart(2, "0")}`);
const TUE = "2026-10-06";

function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}

let nextId = 1;
function shift(date: string, from: string, to: string, extra: Record<string, unknown> = {}) {
  return {
    id: nextId++,
    employee_id: SAM,
    starts_at: edt(date, from),
    ends_at: edt(date, to),
    position: "PENN Opener",
    published: true,
    ...extra,
  };
}

/** Every day open 12:00–22:00, covered by an opener and a closer. */
function fullyCoveredWeek() {
  return DATES.flatMap((d) => [shift(d, "12:00", "17:00"), shift(d, "17:00", "22:00", { employee_id: JO })]);
}

let db: FakeSupabase;

function seed(shifts: Record<string, unknown>[], annotations: Record<string, unknown>[] = []) {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Test Owner" },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee" },
      { id: JO, role: "employee", active: true, full_name: "Jo Park" },
    ],
    store_hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_closed: false, opens: "12:00:00", closes: "22:00:00" })),
    store_hours_exceptions: [],
    shift_types: [
      { name: "PENN Opener", in_store: true },
      { name: "Catering", in_store: false },
    ],
    shifts,
    annotations,
    notifications: [],
    // Zero open-up and close-down minutes: staffed hours are the open hours,
    // so the tests above the staffed-hours section read as open-hours checks.
    control_settings: [minutes("staffing.open_up_minutes", 0), minutes("staffing.close_down_minutes", 0)],
  });
  db.signIn(MANAGER);
}

let settingId = 1;
function minutes(key: string, value: number, effective_from = "2026-01-01") {
  return {
    id: settingId++, key, value, detail: {}, effective_from, review_by: "2027-12-31", source: "invented", method: null,
    recorded_by: null, recorded_at: `${effective_from}T00:00:00Z`,
  };
}

beforeEach(() => seed(fullyCoveredWeek()));

async function run(weekStart = WEEK) {
  const res = await checkWeek.GET(new Request(`http://time.test/api/schedule/check-week?weekStart=${weekStart}`));
  return { status: res.status, body: await res.json() };
}

test("a fully covered week has no gaps", async () => {
  const { status, body } = await run();
  assert.equal(status, 200);
  assert.deepEqual(body, { gaps: [], hoursNotSet: [], staffingNotSet: [] });
});

test("a missing closer is reported as the uncovered stretch of that day", async () => {
  const shifts = fullyCoveredWeek().filter((s) => !(s.starts_at === edt(TUE, "17:00")));
  seed([
    ...shifts,
    // None of these put anybody in the store Tuesday evening:
    shift(TUE, "17:00", "22:00", { published: false }), // a leftover draft
    shift(TUE, "17:00", "22:00", { position: "Catering" }), // off the floor
    shift(TUE, "17:00", "22:00", { employee_id: null }), // an open shift nobody took
  ]);
  const { status, body } = await run();
  assert.equal(status, 200);
  assert.deepEqual(body.gaps, [{ date: TUE, from: "17:00", to: "22:00" }]);
});

test("a day the board marks Business closed needs no cover", async () => {
  const shifts = fullyCoveredWeek().filter((s) => !s.starts_at.startsWith(TUE));
  seed(shifts, [{ id: 1, title: "Closed", start_date: TUE, end_date: TUE, business_closed: true }]);
  const { body } = await run();
  assert.deepEqual(body.gaps, []);
});

test("a shift running in from Saturday evening covers Sunday's opening", async () => {
  // 18:00 New York on Saturday is 22:00 UTC, before the week starts even in UTC:
  // only the query's lead-in days can see it.
  const shifts = fullyCoveredWeek().filter((s) => s.starts_at !== edt(WEEK, "12:00"));
  seed([...shifts, shift("2026-10-03", "18:00", "17:00", { ends_at: edt(WEEK, "17:00") })]);
  const { status, body } = await run();
  assert.equal(status, 200);
  assert.deepEqual(body.gaps, []);
});

test("a weekday with no store hours is listed as not set, not as a gap", async () => {
  const shifts = fullyCoveredWeek().filter((s) => !s.starts_at.startsWith(TUE));
  seed(shifts);
  db.tables.store_hours = db.tables.store_hours.filter((h) => h.weekday !== 2);
  const { status, body } = await run();
  assert.equal(status, 200);
  assert.deepEqual(body, { gaps: [], hoursNotSet: [{ date: TUE, weekday: 2 }], staffingNotSet: [] });
});

test("before the store-hours migration the answer is store_hours_not_set_up", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/v1/store_hours") {
      return new Response(
        JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.store_hours' in the schema cache" }),
        { status: 404 },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { status, body } = await run();
    assert.equal(status, 503);
    assert.equal(body.error, "store_hours_not_set_up");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failed Business-closed read still runs the check", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/v1/annotations") return new Response(JSON.stringify({ message: "timeout" }), { status: 500 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { status, body } = await run();
    assert.equal(status, 200);
    assert.deepEqual(body, { gaps: [], hoursNotSet: [], staffingNotSet: [] });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the check is read-only: no writes and no notifications", async () => {
  // Record attempted writes rather than throwing: a throw would surface as a
  // failed request the check swallows, leaving the tables untouched and the
  // test green even when the check does write.
  const before = structuredClone(db.tables);
  const writes: string[] = [];
  db.beforeWrite = (table) => {
    writes.push(table);
  };
  const { status } = await run();
  assert.equal(status, 200);
  assert.deepEqual(writes, []);
  assert.deepEqual(db.tables, before);
});

test("managers only: an employee is refused", async () => {
  db.signIn(SAM);
  const { status } = await run();
  assert.equal(status, 403);
});

test("weekStart must be a date", async () => {
  const { status } = await run("next-week");
  assert.equal(status, 400);
});

test("a failed shifts read is never reported as covered", async () => {
  // The outage is simulated at the transport: the shifts read times out.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/v1/shifts") return new Response(JSON.stringify({ message: "timeout" }), { status: 500 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { status, body } = await run();
    assert.equal(status, 503);
    assert.equal(body.error, "coverage_unavailable");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("shiftsTouchingWeek keeps the overnight spill-in and drops shifts outside the week", () => {
  const rows = [
    { tag: "in-week", starts_at: edt(TUE, "12:00"), ends_at: edt(TUE, "17:00") },
    { tag: "spill-in", starts_at: edt("2026-10-03", "22:00"), ends_at: edt(WEEK, "06:00") },
    { tag: "before", starts_at: edt("2026-10-03", "12:00"), ends_at: edt("2026-10-03", "17:00") },
    { tag: "after", starts_at: edt("2026-10-11", "12:00"), ends_at: edt("2026-10-11", "17:00") },
  ];
  assert.deepEqual(shiftsTouchingWeek(rows, WEEK).map((r) => r.tag), ["in-week", "spill-in"]);
});

// --- the button ---------------------------------------------------------------

test("the Check week button renders for a manager", () => {
  const html = renderToStaticMarkup(createElement(CheckWeekButton as never, { isManager: true, weekStart: WEEK }));
  assert.match(html, /<button[^>]*>Check week<\/button>/);
});

test("the Check week button renders nothing for an employee", () => {
  const html = renderToStaticMarkup(createElement(CheckWeekButton as never, { isManager: false, weekStart: WEEK }));
  assert.equal(html, "");
});

// --- Store-hours seasons (migration 47, bj-finance #742) ----------------------
// From its first day a season's hours replace the weekly pattern, so the check
// asks for cover only within them. Before the migration the weekly pattern
// stands; a failed seasons read is never reported as covered.

/** The full week with Tuesday's 17:00–22:00 closer missing. */
const noTuesdayCloser = () => fullyCoveredWeek().filter((s) => s.starts_at !== edt(TUE, "17:00"));

/** A season from `from`: every day 12:00–17:00. */
const earlySeason = (from: string) =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ effective_from: from, weekday, name: "Test early", is_closed: false, opens: "12:00:00", closes: "17:00:00" }));

test("a season in force shortens the hours the week must cover", async () => {
  seed(noTuesdayCloser());
  db.tables.store_hours_seasons = earlySeason(TUE);
  const { status, body } = await run();
  assert.equal(status, 200);
  assert.deepEqual(body, { gaps: [], hoursNotSet: [], staffingNotSet: [] });
});

test("a season that starts after the day leaves that day on the weekly hours", async () => {
  seed(noTuesdayCloser());
  db.tables.store_hours_seasons = earlySeason("2026-10-07");
  const { body } = await run();
  assert.deepEqual(body.gaps, [{ date: TUE, from: "17:00", to: "22:00" }]);
});

test("before migration 47 the weekly hours stand", async () => {
  seed(noTuesdayCloser());
  db.missingTables.push("store_hours_seasons");
  const { status, body } = await run();
  assert.equal(status, 200);
  assert.deepEqual(body.gaps, [{ date: TUE, from: "17:00", to: "22:00" }]);
});

test("a failed seasons read is never reported as covered", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/v1/store_hours_seasons") return new Response(JSON.stringify({ message: "timeout" }), { status: 500 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { status, body } = await run();
    assert.equal(status, 503);
    assert.equal(body.error, "coverage_unavailable");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- Staffed hours (bj-finance #742 follow-up, ruled 2026-10-19) -------------
// Cover is measured against staffed hours: the open hours plus the open-up
// minutes before and the close-down minutes after, from the Targets tab.
// Unset, the check falls back to open hours and names the days it did so.

test("the week must be covered for its staffed hours: open-up before opening and close-down after closing", async () => {
  seed(fullyCoveredWeek());
  db.tables.control_settings = [minutes("staffing.open_up_minutes", 45), minutes("staffing.close_down_minutes", 15)];
  const { status, body } = await run();
  assert.equal(status, 200);
  assert.equal(body.gaps.length, 14);
  assert.deepEqual(body.gaps.filter((g: { date: string }) => g.date === TUE), [
    { date: TUE, from: "11:15", to: "12:00" },
    { date: TUE, from: "22:00", to: "22:15" },
  ]);
  assert.deepEqual(body.staffingNotSet, []);
});

test("minutes dated after a day leave that day on its open hours, as the board reads them", async () => {
  seed(fullyCoveredWeek());
  db.tables.control_settings = [minutes("staffing.open_up_minutes", 45, "2026-10-09"), minutes("staffing.close_down_minutes", 0)];
  const { body } = await run();
  assert.deepEqual(body.gaps, [
    { date: "2026-10-09", from: "11:15", to: "12:00" },
    { date: "2026-10-10", from: "11:15", to: "12:00" },
  ]);
  assert.deepEqual(body.staffingNotSet, DATES.slice(0, 5));
});

test("with no minutes set the check covers open hours and says which days it did so", async () => {
  seed(fullyCoveredWeek());
  db.tables.control_settings = [];
  const { status, body } = await run();
  assert.equal(status, 200);
  assert.deepEqual(body.gaps, []);
  assert.deepEqual(body.staffingNotSet, DATES);
});

test("before migration 43 there are no minutes: open hours stand", async () => {
  seed(fullyCoveredWeek());
  db.missingTables.push("control_settings");
  const { status, body } = await run();
  assert.equal(status, 200);
  assert.deepEqual(body.gaps, []);
  assert.deepEqual(body.staffingNotSet, DATES);
});

test("a failed read of the minutes is never reported as covered", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/rest/v1/control_settings") return new Response(JSON.stringify({ message: "timeout" }), { status: 500 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const { status, body } = await run();
    assert.equal(status, 503);
    assert.equal(body.error, "coverage_unavailable");
  } finally {
    globalThis.fetch = realFetch;
  }
});
