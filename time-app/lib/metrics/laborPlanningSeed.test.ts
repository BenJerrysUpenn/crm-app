// The local preview's inputs file (bj-finance #742): the planning inputs
// editor saves to it instead of the database, in the shape bj-finance's
// `labor_planning inputs` loader reads, so the chart reflects an edit and the
// file can later be loaded as it stands. Invented names, dates and figures
// only.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { applySeedAction, seedClosedDays, seedRevisions, seedSeasonRows, type Seed } from "./laborPlanningSeed.ts";

const NOW = "2030-10-01T15:00:00.000Z";
const NOTE = { review_by: "2031-03-01", source: "invented", method: "by hand" };
const SEASON = { name: "Test winter", effective_from: "2030-11-01", opens: "13:00", closes: "21:00", closed_weekdays: [] as number[], ...NOTE };

function apply(seed: Seed, action: Parameters<typeof applySeedAction>[1]): Seed {
  const r = applySeedAction(seed, action, NOW);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
}

test("a season is written as the loader's groups: its open weekdays, then its closed ones", () => {
  const seed = apply({ _about: "kept", seasons: [] }, { kind: "season", body: { ...SEASON, closed_weekdays: [1, 2] } });
  assert.equal(seed._about, "kept");
  assert.deepEqual(seed.seasons, [
    { name: "Test winter", effective_from: "2030-11-01", opens: "13:00", closes: "21:00", weekdays: [0, 3, 4, 5, 6], ...NOTE },
    { name: "Test winter", effective_from: "2030-11-01", is_closed: true, weekdays: [1, 2], ...NOTE },
  ]);
  // Every day open: one group, no weekday list (the loader's "every day").
  const open = apply(seed, { kind: "season", body: SEASON });
  assert.deepEqual(open.seasons, [{ name: "Test winter", effective_from: "2030-11-01", opens: "13:00", closes: "21:00", ...NOTE }]);
});

test("season groups read back as seven weekday rows each, with their notes", () => {
  const seed = apply({}, { kind: "season", body: { ...SEASON, closed_weekdays: [1] } });
  const rows = seedSeasonRows(seed);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.find((r) => r.weekday === 1), { effective_from: "2030-11-01", weekday: 1, name: "Test winter", is_closed: true, opens: null, closes: null, ...NOTE });
  assert.deepEqual(rows.find((r) => r.weekday === 0), { effective_from: "2030-11-01", weekday: 0, name: "Test winter", is_closed: false, opens: "13:00:00", closes: "21:00:00", ...NOTE });
});

test("removing a season removes all its groups and nothing else", () => {
  let seed = apply({}, { kind: "season", body: { ...SEASON, closed_weekdays: [1] } });
  seed = apply(seed, { kind: "season", body: { ...SEASON, name: "Test summer", effective_from: "2031-04-01", review_by: "2031-09-01" } });
  seed = apply(seed, { kind: "season_remove", from: "2030-11-01" });
  assert.deepEqual(seed.seasons?.map((s) => s.name), ["Test summer"]);
});

test("an event change is appended as a revision with when it was recorded; the old one stays", () => {
  const body = { name: "Test Expo", start_date: "2030-12-01", end_date: "2030-12-03", expected_net_sales: 300, effective_from: "2030-10-01", ...NOTE };
  let seed = apply({}, { kind: "concession", body });
  seed = apply(seed, { kind: "concession", body: { ...body, event_key: "test-expo-2030", expected_net_sales: 450 } });
  assert.deepEqual(
    seed.concession_events?.map((e) => [e.event_key, e.expected_net_sales, e.cancelled, e.recorded_at]),
    [["test-expo-2030", 300, false, NOW], ["test-expo-2030", 450, false, NOW]],
  );
  // Read back, the later of two same-day revisions is the one in force.
  const rows = seedRevisions(seed.concession_events);
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);
  seed = apply(seed, { kind: "crew", body: { name: "Test Cone Day", day: "2031-04-10", crew_hours: 12, effective_from: "2030-10-01", ...NOTE } });
  assert.deepEqual(seed.crew_events?.map((e) => [e.event_key, e.crew_hours]), [["test-cone-day-2031", 12]]);
});

test("revisions from a file written by hand, with no recorded time, still sort by their as-of date", () => {
  const rows = seedRevisions([{ event_key: "k", effective_from: "2030-01-01" }, { event_key: "k", effective_from: "2030-02-01", cancelled: true }]);
  assert.deepEqual(rows.map((r) => [r.id, r.recorded_at, r.cancelled]), [[1, "2030-01-01T00:00:00Z", false], [2, "2030-02-01T00:00:00Z", true]]);
});

test("closed days are added once per date and removed by date", () => {
  let seed = apply({}, { kind: "closed_day", body: { date: "2030-11-28", label: "Thanksgiving" } });
  seed = apply(seed, { kind: "closed_day", body: { date: "2030-11-28", label: "Thanksgiving Day" } });
  seed = apply(seed, { kind: "closed_day", body: { date: "2030-12-25", label: "" } });
  assert.deepEqual(seed.closed_days, [{ date: "2030-11-28", label: "Thanksgiving Day" }, { date: "2030-12-25", label: null }]);
  assert.deepEqual(seedClosedDays(seed).map((e) => [e.date, e.is_closed]), [["2030-11-28", true], ["2030-12-25", true]]);
  seed = apply(seed, { kind: "closed_day_remove", date: "2030-11-28" });
  assert.deepEqual(seed.closed_days?.map((d) => d.date), ["2030-12-25"]);
});

test("the file is checked as the routes check the database", () => {
  const cases: [Parameters<typeof applySeedAction>[1], RegExp][] = [
    [{ kind: "season", body: { ...SEASON, opens: "22:00" } }, /close after it opens/],
    [{ kind: "concession", body: { name: "x", start_date: "2030-12-01", end_date: "2030-12-01", expected_net_sales: 1, effective_from: "2030-10-01", ...NOTE, event_key: "nope" } }, /No such event/],
    [{ kind: "closed_day", body: { date: "2030-02-30", label: "" } }, /real date/],
    [{ kind: "closed_day", body: { date: "2030-11-28", label: "x".repeat(121) } }, /too long/],
    [{ kind: "season_remove", from: "soon" }, /start date/],
    [{ kind: "nonsense" } as never, /Unknown change/],
  ];
  for (const [action, why] of cases) {
    const r = applySeedAction({}, action, NOW);
    assert.equal(r.ok, false, JSON.stringify(action));
    if (!r.ok) assert.match(r.error, why);
  }
});
