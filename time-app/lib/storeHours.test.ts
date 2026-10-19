// What the Team page says a holiday or closed date looks like once store-hours
// seasons exist (migration 47, bj-finance #742): describeDay with the season
// storeHoursFor finds in force on the date. Invented seasons and dates only.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { describeDay } from "./storeHours.ts";
import { storeHoursFor } from "./coverage.ts";
import type { StoreHours, StoreHoursSeason } from "./types.ts";

// Thursday 2030-11-28 and Thursday 2031-04-03; weekday 4 is Thursday.
const THANKSGIVING = "2030-11-28";
const THU = 4;

const WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_closed: false, opens: "10:00:00", closes: "22:00:00" })) as StoreHours[];

const season = (effective_from: string, name: string, over: Partial<StoreHoursSeason> = {}): StoreHoursSeason[] =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ effective_from, weekday, name, is_closed: false, opens: "13:00:00", closes: "21:00:00", ...over }));

const SEASONS = [...season("2030-11-01", "Test winter"), ...season("2031-04-01", "Test summer", { opens: "11:00:00", closes: "23:00:00" })];

test("the season in force on a date is the latest one started on or before it, for its weekday", () => {
  assert.equal(storeHoursFor("2030-10-31", SEASONS), undefined, "before the first season");
  assert.deepEqual(storeHoursFor(THANKSGIVING, SEASONS), { effective_from: "2030-11-01", weekday: THU, name: "Test winter", is_closed: false, opens: "13:00:00", closes: "21:00:00" });
  assert.equal(storeHoursFor("2031-04-01", SEASONS)?.name, "Test summer", "from its first day");
  assert.equal(storeHoursFor("2031-04-03", SEASONS)?.weekday, THU);
});

test("a date in a season reads as the season's hours, by name", () => {
  assert.equal(describeDay(WEEK, undefined, THU, storeHoursFor(THANKSGIVING, SEASONS)), "Open, Test winter hours (1:00 PM – 9:00 PM)");
  assert.equal(describeDay(WEEK, undefined, THU, undefined), "Open, normal hours (10:00 AM – 10:00 PM)", "without a season: the weekly hours");
});

test("a weekday a season closes reads as closed for that season", () => {
  const closedThursdays = season("2030-11-01", "Test winter").map((s) => (s.weekday === THU ? { ...s, is_closed: true, opens: null, closes: null } : s));
  assert.equal(describeDay(WEEK, undefined, THU, storeHoursFor(THANKSGIVING, closedThursdays)), "Closed (Test winter season)");
});

test("a closed date or short hours on the date win over the season", () => {
  const winter = storeHoursFor(THANKSGIVING, SEASONS);
  assert.equal(describeDay(WEEK, { date: THANKSGIVING, label: "Thanksgiving", is_closed: true, opens: null, closes: null, created_at: null }, THU, winter), "Closed");
  assert.equal(describeDay(WEEK, { date: THANKSGIVING, label: "Early close", is_closed: false, opens: "12:00:00", closes: "16:00:00", created_at: null }, THU, winter), "12:00 PM – 4:00 PM");
});
