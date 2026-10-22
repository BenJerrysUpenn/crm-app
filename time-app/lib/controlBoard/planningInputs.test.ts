// The Labor Hours Planning inputs on the Targets tab (bj-finance #742):
// store-hours seasons, concession events, and the quick-add
// holidays for closed days. Every name, date and figure here is invented:
// crm-app is public.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  QUICK_HOLIDAYS,
  eventKeyFor,
  eventList,
  nextHoliday,
  parseConcessionInput,
  parseSeasonInput,
  quickHolidays,
  repeatNextYear,
  seasonInForce,
  seasonRowsFrom,
  seasonsFrom,
  seasonWords,
  type ConcessionEventRow,
  type SeasonRow,
} from "./planningInputs.ts";

const NOTE = { review_by: "2031-01-01", source: "invented", method: "by hand" };

// ---- holidays ------------------------------------------------------------------------

test("the quick-add holidays are Thanksgiving, Christmas Day and New Year's Day", () => {
  assert.deepEqual([...QUICK_HOLIDAYS], ["Thanksgiving", "Christmas Day", "New Year's Day"]);
});

test("each holiday's next date comes from its calendar rule", () => {
  assert.equal(nextHoliday("Thanksgiving", "2030-10-01"), "2030-11-28"); // 4th Thursday of November
  assert.equal(nextHoliday("Christmas Day", "2030-10-01"), "2030-12-25");
  assert.equal(nextHoliday("New Year's Day", "2030-10-01"), "2031-01-01");
  assert.equal(nextHoliday("Thanksgiving", "2031-10-01"), "2031-11-27");
  assert.equal(nextHoliday("Thanksgiving", "2032-10-01"), "2032-11-25");
});

test("a holiday that is today is still the next one; the day after, it is next year's", () => {
  assert.equal(nextHoliday("Christmas Day", "2030-12-25"), "2030-12-25");
  assert.equal(nextHoliday("Christmas Day", "2030-12-26"), "2031-12-25");
  assert.equal(nextHoliday("Thanksgiving", "2030-11-29"), "2031-11-27");
  assert.equal(nextHoliday("New Year's Day", "2031-01-02"), "2032-01-01");
});

test("a holiday shows as added once its date is marked closed", () => {
  const list = quickHolidays("2030-10-01", [
    { date: "2030-11-28", label: "Thanksgiving", is_closed: true, opens: null, closes: null, created_at: null },
    { date: "2030-12-25", label: "Short day", is_closed: false, opens: "12:00:00", closes: "16:00:00", created_at: null },
  ]);
  assert.deepEqual(list, [
    { name: "Thanksgiving", date: "2030-11-28", added: true },
    { name: "Christmas Day", date: "2030-12-25", added: false },
    { name: "New Year's Day", date: "2031-01-01", added: false },
  ]);
});

// ---- store-hours seasons ---------------------------------------------------------------

function seasonRow(over: Partial<SeasonRow>): SeasonRow {
  return { effective_from: "2030-11-01", weekday: 0, name: "Test winter", is_closed: false, opens: "13:00:00", closes: "21:00:00", ...NOTE, ...over };
}

const week = (over: (wd: number) => Partial<SeasonRow>) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => seasonRow({ weekday, ...over(weekday) }));

test("a season's seven weekday rows read as one season, oldest first", () => {
  const rows = [
    ...week(() => ({ effective_from: "2031-04-01", name: "Test summer", opens: "10:00:00", closes: "22:00:00" })),
    ...week((wd) => (wd === 1 ? { is_closed: true, opens: null, closes: null } : {})),
  ];
  const seasons = seasonsFrom(rows);
  assert.equal(seasons.length, 2);
  assert.deepEqual(
    seasons.map((s) => [s.effective_from, s.name, s.opens, s.closes, s.closedWeekdays, s.mixed]),
    [
      ["2030-11-01", "Test winter", "13:00:00", "21:00:00", [1], false],
      ["2031-04-01", "Test summer", "10:00:00", "22:00:00", [], false],
    ],
  );
  assert.equal(seasons[0].source, "invented");
});

test("a season whose open days differ is marked mixed", () => {
  const s = seasonsFrom(week((wd) => (wd === 6 ? { opens: "11:00:00" } : {})))[0];
  assert.equal(s.mixed, true);
});

// Staffed hours (bj-finance #742 follow-up): each season shows its open hours
// and its staffed hours, the open-up and close-down minutes in force on the
// day asked about. Invented minutes.
const minutesRow = (key: string, value: number, effective_from = "2030-01-01") => ({
  id: value, key, value, effective_from, recorded_at: `${effective_from}T00:00:00Z`,
});
const STAFFING = [minutesRow("staffing.open_up_minutes", 45), minutesRow("staffing.close_down_minutes", 15)];

test("a season shows both windows: open hours, and staffed hours widened by the minutes in force", () => {
  const seasons = seasonsFrom([
    ...week((wd) => (wd === 1 ? { is_closed: true, opens: null, closes: null } : {})),
    ...week(() => ({ effective_from: "2031-04-01", name: "Test summer", opens: "10:00:00", closes: "22:00:00" })),
  ]);
  assert.equal(
    seasonWords(seasons[0], { rows: STAFFING, asOf: "2030-11-01" }),
    "Open 1:00 PM to 9:00 PM, staffed 12:15 PM to 9:15 PM, closed Monday",
  );
  assert.equal(
    seasonWords(seasons[1], { rows: STAFFING, asOf: "2031-04-01" }),
    "Open 10:00 AM to 10:00 PM, staffed 9:15 AM to 10:15 PM, every day",
  );
  // Minutes that change later are read on the day asked about.
  const later = [...STAFFING, minutesRow("staffing.open_up_minutes", 60, "2031-01-01")];
  assert.match(seasonWords(seasons[0], { rows: later, asOf: "2031-01-02" }), /staffed 12:00 PM to 9:15 PM/);
  assert.doesNotMatch(seasonWords(seasons[0], { rows: STAFFING, asOf: "2030-11-01" }), /\u2014/, "no em dashes");
});

test("a season with the minutes not set shows its staffed hours as its open hours and says so", () => {
  const s = seasonsFrom(week(() => ({})))[0];
  assert.equal(
    seasonWords(s, { rows: [], asOf: "2030-11-01" }),
    "Open 1:00 PM to 9:00 PM, staffed 1:00 PM to 9:00 PM, every day (open-up and close-down minutes not set)",
  );
  assert.equal(
    seasonWords(s, { rows: [STAFFING[0]], asOf: "2030-11-01" }),
    "Open 1:00 PM to 9:00 PM, staffed 12:15 PM to 9:00 PM, every day (close-down minutes not set)",
  );
});

test("a mixed season shows both windows day by day; a closed day stays closed", () => {
  const s = seasonsFrom(week((wd) => (wd === 6 ? { opens: "11:00:00" } : wd === 1 ? { is_closed: true, opens: null, closes: null } : {})))[0];
  const words = seasonWords(s, { rows: STAFFING, asOf: "2030-11-01" });
  assert.match(words, /^Sun open 1:00 PM to 9:00 PM, staffed 12:15 PM to 9:15 PM; Mon closed; /);
  assert.match(words, /Sat open 11:00 AM to 9:00 PM, staffed 10:15 AM to 9:15 PM$/);
});

test("the season in force today is the latest one started on or before today", () => {
  const seasons = seasonsFrom([...week(() => ({})), ...week(() => ({ effective_from: "2031-04-01", name: "Test summer" }))]);
  assert.equal(seasonInForce(seasons, "2030-10-31"), null);
  assert.equal(seasonInForce(seasons, "2030-11-01")?.name, "Test winter");
  assert.equal(seasonInForce(seasons, "2031-03-31")?.name, "Test winter");
  assert.equal(seasonInForce(seasons, "2031-04-01")?.name, "Test summer");
});

test("a season is saved as seven weekday rows, the closed weekdays with no times", () => {
  const p = parseSeasonInput({ name: " Test winter ", effective_from: "2030-11-01", opens: "13:00", closes: "21:00", closed_weekdays: [1, 2], ...NOTE });
  assert.ok(p.ok, p.ok ? "" : p.error);
  assert.equal(p.value.length, 7);
  assert.deepEqual(
    p.value.map((r) => [r.weekday, r.is_closed, r.opens, r.closes, r.name]),
    [
      [0, false, "13:00:00", "21:00:00", "Test winter"],
      [1, true, null, null, "Test winter"],
      [2, true, null, null, "Test winter"],
      [3, false, "13:00:00", "21:00:00", "Test winter"],
      [4, false, "13:00:00", "21:00:00", "Test winter"],
      [5, false, "13:00:00", "21:00:00", "Test winter"],
      [6, false, "13:00:00", "21:00:00", "Test winter"],
    ],
  );
  assert.deepEqual([p.value[0].effective_from, p.value[0].review_by, p.value[0].source, p.value[0].method], ["2030-11-01", "2031-01-01", "invented", "by hand"]);
  // And reading the rows back gives the same season.
  const back = seasonsFrom(p.value)[0];
  assert.deepEqual([back.opens, back.closes, back.closedWeekdays], ["13:00:00", "21:00:00", [1, 2]]);
  assert.deepEqual(seasonRowsFrom(back), p.value);
});

test("repeat next year: the same season a year later, its review-by a year later too, ready to save", () => {
  const p = parseSeasonInput({ name: "Test winter", effective_from: "2030-11-01", opens: "13:00", closes: "21:00", ...NOTE });
  assert.ok(p.ok);
  const body = repeatNextYear(seasonsFrom(p.value)[0]);
  assert.deepEqual(body, {
    name: "Test winter", effective_from: "2031-11-01", opens: "13:00", closes: "21:00", closed_weekdays: [],
    review_by: "2032-01-01", source: "invented", method: "by hand",
  });
  const next = parseSeasonInput(body);
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.ok(next.value.every((r) => r.effective_from === "2031-11-01" && r.opens === "13:00:00"));
  // A season with no review-by or source still saves: review a year after its new first day.
  const bare = repeatNextYear({ ...seasonsFrom(p.value)[0], review_by: null, source: null, method: null });
  assert.equal(bare.review_by, "2032-11-01");
  assert.ok(parseSeasonInput(bare).ok);
});

test("a season closed every day needs no times", () => {
  const p = parseSeasonInput({ name: "Test closed", effective_from: "2030-11-01", closed_weekdays: [0, 1, 2, 3, 4, 5, 6], ...NOTE });
  assert.ok(p.ok);
  assert.ok(p.value.every((r) => r.is_closed && r.opens == null));
});

test("a season that does not make sense is refused with the reason", () => {
  const ok = { name: "Test winter", effective_from: "2030-11-01", opens: "13:00", closes: "21:00", closed_weekdays: [], ...NOTE };
  const cases: [unknown, RegExp][] = [
    [null, /JSON body/],
    [{ ...ok, name: "  " }, /Give the season a name/],
    [{ ...ok, name: "x".repeat(81) }, /at most 80/],
    [{ ...ok, effective_from: "2030-02-30" }, /start date/],
    [{ ...ok, opens: "21:00", closes: "13:00" }, /close after it opens/],
    [{ ...ok, closes: "" }, /opening and a closing time/],
    [{ ...ok, closed_weekdays: [7] }, /weekday/],
    [{ ...ok, closed_weekdays: "1" }, /weekday/],
    [{ ...ok, review_by: "2030-10-01" }, /review-by date cannot be before/],
    [{ ...ok, source: "" }, /where the value came from/],
  ];
  for (const [body, why] of cases) {
    const p = parseSeasonInput(body);
    assert.equal(p.ok, false, JSON.stringify(body));
    if (!p.ok) assert.match(p.error, why, JSON.stringify(body));
  }
});

// ---- events ----------------------------------------------------------------------------

function concession(over: Partial<ConcessionEventRow>): ConcessionEventRow {
  return {
    id: 1, event_key: "test-expo-2030", name: "Test Expo 2030", start_date: "2030-12-01", end_date: "2030-12-03", expected_net_sales: 300,
    provisional: false, cancelled: false, effective_from: "2030-06-01", recorded_at: "2030-06-01T12:00:00Z", ...NOTE, ...over,
  };
}

test("each event shows its revision in force today, with every revision as its history", () => {
  const rows = [
    concession({ id: 1 }),
    concession({ id: 2, expected_net_sales: 400, effective_from: "2030-09-01", recorded_at: "2030-09-01T12:00:00Z" }),
    concession({ id: 3, expected_net_sales: 500, effective_from: "2030-11-01", recorded_at: "2030-09-02T12:00:00Z" }),
    concession({ id: 4, event_key: "test-fair-2031", name: "Test Fair", start_date: "2031-01-05", end_date: "2031-01-06" }),
  ];
  const list = eventList(rows, "2030-10-01");
  assert.deepEqual(list.map((e) => [e.key, e.current.id, e.inForce, e.history.map((h) => h.id)]), [
    ["test-expo-2030", 2, true, [3, 2, 1]],
    ["test-fair-2031", 4, true, [4]],
  ]);
});

test("an event with only future revisions shows the first one, marked not in force yet", () => {
  const list = eventList([concession({ id: 7, effective_from: "2030-11-01" }), concession({ id: 8, effective_from: "2030-12-01" })], "2030-10-01");
  assert.deepEqual([list[0].current.id, list[0].inForce], [7, false]);
});

test("a same-day correction wins over the revision it corrects", () => {
  const list = eventList([concession({ id: 1 }), concession({ id: 2, expected_net_sales: 350, recorded_at: "2030-06-01T15:00:00Z" })], "2030-10-01");
  assert.equal(list[0].current.expected_net_sales, 350);
});

test("a new event's key is its name in lower-case words, with the year, never one already taken", () => {
  assert.equal(eventKeyFor("Test Expo", "2030-12-01", new Set()), "test-expo-2030");
  assert.equal(eventKeyFor("Test Expo 2030", "2030-12-01", new Set()), "test-expo-2030");
  assert.equal(eventKeyFor("Test Expo", "2030-12-01", new Set(["test-expo-2030"])), "test-expo-2030-2");
  assert.equal(eventKeyFor("Test Expo", "2030-12-01", new Set(["test-expo-2030", "test-expo-2030-2"])), "test-expo-2030-3");
  assert.equal(eventKeyFor("Café & Co!", "2030-12-01", new Set()), "cafe-co-2030");
  assert.equal(eventKeyFor("!!!", "2030-12-01", new Set()), "event-2030");
  assert.ok(eventKeyFor("x".repeat(200), "2030-12-01", new Set()).length <= 80);
});

test("a concession event revision: a new event gets a key, a change keeps its event's key", () => {
  const input = { name: "Test Expo", start_date: "2030-12-01", end_date: "2030-12-03", expected_net_sales: "1,234.567", provisional: true, effective_from: "2030-06-01", ...NOTE };
  const fresh = parseConcessionInput(input, new Set(["test-expo-2030"]));
  assert.ok(fresh.ok, fresh.ok ? "" : fresh.error);
  assert.deepEqual(
    [fresh.value.event_key, fresh.value.name, fresh.value.expected_net_sales, fresh.value.provisional, fresh.value.cancelled],
    ["test-expo-2030-2", "Test Expo", 1234.57, true, false],
  );
  const change = parseConcessionInput({ ...input, event_key: "test-expo-2030", cancelled: true }, new Set(["test-expo-2030"]));
  assert.ok(change.ok);
  assert.deepEqual([change.value.event_key, change.value.cancelled], ["test-expo-2030", true]);
});

test("a concession event that does not make sense is refused with the reason", () => {
  const ok = { name: "Test Expo", start_date: "2030-12-01", end_date: "2030-12-03", expected_net_sales: 300, effective_from: "2030-06-01", ...NOTE };
  const cases: [unknown, RegExp][] = [
    [{ ...ok, event_key: "no-such-event" }, /No such event/],
    [{ ...ok, name: "" }, /Give the event a name/],
    [{ ...ok, name: "x".repeat(121) }, /at most 120/],
    [{ ...ok, start_date: "2030-12-04" }, /cannot end before it starts/],
    [{ ...ok, end_date: "soon" }, /last day/],
    [{ ...ok, expected_net_sales: -1 }, /cannot be negative/],
    [{ ...ok, expected_net_sales: "lots" }, /must be a number/],
    [{ ...ok, expected_net_sales: 1e10 }, /too large/],
    [{ ...ok, source: " " }, /where the value came from/],
  ];
  for (const [body, why] of cases) {
    const p = parseConcessionInput(body, new Set(["test-expo-2030"]));
    assert.equal(p.ok, false, JSON.stringify(body));
    if (!p.ok) assert.match(p.error, why, JSON.stringify(body));
  }
});
