// Destinations mode (bj-finance #210, rulings 2, 14, 45): the trip starts at
// the store unless "Start at the store" is off, goes through the stops in
// order and ends at the store unless "End at the store" is off; Google's
// Routes API gives each leg's driving distance, one traffic-aware call per
// leg timed at the trip's hour (the same calculation as a catering quote's
// miles, Catering-Manager modules/maps.py), each leg is rounded to 0.1 mi
// half-up, and the miles are their sum. Computed on the server only: the key
// never reaches a browser.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NO_TIME_DEPARTURE,
  OUTBOUND_LEAD_MINUTES,
  ROUTES_ENDPOINT,
  STORE_ADDRESS,
  cleanRoute,
  cleanStops,
  legDepartures,
  nextSameWeekday,
  nyInstant,
  placeLabel,
  routeMiles,
  routePoints,
  routeText,
  type TripTiming,
} from "./routeMiles.ts";

const BOTH = { start_at_store: true, end_at_store: true };
// Thursday 2026-10-29, 10:00 in Philadelphia (EDT, UTC-4).
const NOW = new Date("2026-10-29T14:00:00Z");
const ERRANDS: TripTiming = { trip_date: "2026-10-20", event: null }; // a Tuesday
const opts = (fetchImpl: typeof fetch) => ({ apiKey: "k", fetchImpl, now: NOW });

const MI = 1609.344;

/** A stand-in Routes API: the i-th call answers legsMeters[i] (undefined: a route with no distance). */
function fakeRoutes(legsMeters: (number | undefined)[], status = 200) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const i = calls.length;
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status });
    if (i >= legsMeters.length) return new Response(JSON.stringify({}), { status: 200 });
    const m = legsMeters[i];
    return new Response(JSON.stringify({ routes: [m === undefined ? {} : { distanceMeters: m }] }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("the store is 218 S 40th St", () => {
  assert.equal(STORE_ADDRESS, "218 S 40th St, Philadelphia, PA 19104");
});

test("routePoints: the store first and last only when Start / End at the store are on", () => {
  assert.deepEqual(routePoints(["A", "B"], BOTH), [STORE_ADDRESS, "A", "B", STORE_ADDRESS]);
  assert.deepEqual(routePoints(["A", "B"], { start_at_store: true, end_at_store: false }), [STORE_ADDRESS, "A", "B"]);
  // home -> Restaurant Depot -> store: only Restaurant Depot -> store is paid (ruling 45).
  assert.deepEqual(routePoints(["Restaurant Depot"], { start_at_store: false, end_at_store: true }), ["Restaurant Depot", STORE_ADDRESS]);
  assert.deepEqual(routePoints(["A", "B"], { start_at_store: false, end_at_store: false }), ["A", "B"]);
});

test("cleanRoute: at least two points in all; both ends off needs two stops", () => {
  assert.deepEqual(cleanRoute([" Depot "], { start_at_store: false, end_at_store: true }), { ok: true, stops: ["Depot"] });
  assert.deepEqual(cleanRoute(["Depot"], { start_at_store: true, end_at_store: false }), { ok: true, stops: ["Depot"] });
  const one = cleanRoute(["Depot"], { start_at_store: false, end_at_store: false });
  assert.equal(one.ok, false);
  assert.match(!one.ok ? one.error : "", /two stops/);
  assert.deepEqual(cleanRoute(["A", "B"], { start_at_store: false, end_at_store: false }), { ok: true, stops: ["A", "B"] });
  assert.equal(cleanRoute([], BOTH).ok, false);
});

test("legs and routes show the store as Store, not its address", () => {
  assert.equal(placeLabel(STORE_ADDRESS), "Store");
  assert.equal(placeLabel("3417 Spruce St"), "3417 Spruce St");
  assert.equal(routeText(["Venue"], BOTH), "Store → Venue → Store");
  assert.equal(routeText(["Depot"], { start_at_store: false, end_at_store: true }), "Depot → Store");
  assert.equal(routeText(["A", "B"], { start_at_store: false, end_at_store: false }), "A → B");
});

test("cleanStops: trims, drops blanks, refuses none or too many", () => {
  assert.deepEqual(cleanStops([" A ", "", "B"]), { ok: true, stops: ["A", "B"] });
  assert.equal(cleanStops([]).ok, false);
  assert.equal(cleanStops(["  "]).ok, false);
  assert.equal(cleanStops("A").ok, false);
  assert.equal(cleanStops(Array.from({ length: 11 }, (_, i) => `stop ${i}`)).ok, false);
  assert.equal(cleanStops(["x".repeat(301)]).ok, false);
});

test("nextSameWeekday: the first date after today on the trip's weekday, 1 to 7 days ahead", () => {
  assert.equal(nextSameWeekday("2026-10-20", "2026-10-29"), "2026-11-03"); // Tue -> next Tue
  assert.equal(nextSameWeekday("2026-10-22", "2026-10-29"), "2026-11-05"); // a Thursday, today Thursday: a week on
  assert.equal(nextSameWeekday("2026-10-30", "2026-10-29"), "2026-10-30");
});

test("nyInstant: Philadelphia wall clock to UTC, either side of DST, and minutes past midnight roll the day", () => {
  assert.equal(nyInstant("2026-10-30", 11 * 60), "2026-10-30T15:00:00.000Z"); // EDT
  assert.equal(nyInstant("2026-11-03", 12 * 60), "2026-11-03T17:00:00.000Z"); // EST
  assert.equal(nyInstant("2026-11-03", -15), "2026-11-03T04:45:00.000Z"); // 23:45 the night before
  assert.equal(nyInstant("2026-11-03", 24 * 60 + 30), "2026-11-04T05:30:00.000Z");
});

test("nyInstant: on the day the clocks change, a time after the change takes the new offset", () => {
  // Clocks go back at 02:00 EDT on Sun 2026-11-01: 03:00 that morning is EST.
  assert.equal(nyInstant("2026-11-01", 3 * 60), "2026-11-01T08:00:00.000Z");
  // Clocks go forward at 02:00 EST on Sun 2027-03-14: 03:00 that morning is EDT.
  assert.equal(nyInstant("2027-03-14", 3 * 60), "2027-03-14T07:00:00.000Z");
});

test("legDepartures: errands leave at noon on the next date with the trip's weekday", () => {
  assert.equal(NO_TIME_DEPARTURE, "12:00");
  assert.deepEqual(legDepartures(2, BOTH, ERRANDS, NOW), ["2026-11-03T17:00:00.000Z", "2026-11-03T17:00:00.000Z"]);
});

test("legDepartures: a Catering Event goes out 45 minutes before it starts and comes back at its end, as a catering quote is priced", () => {
  assert.equal(OUTBOUND_LEAD_MINUTES, 45);
  // Saturday 2026-10-24, 14:00 to 16:30. The next Saturday after Thu 10-29 is 10-31 (EDT).
  const ev: TripTiming = { trip_date: "2026-10-24", event: { date: "2026-10-24", start_time: "14:00", end_time: "16:30" } };
  assert.deepEqual(legDepartures(2, BOTH, ev, NOW), ["2026-10-31T17:15:00.000Z", "2026-10-31T20:30:00.000Z"]);
  // Store -> Depot -> venue -> store: every leg but the last goes out at 13:15.
  assert.deepEqual(legDepartures(3, BOTH, ev, NOW), ["2026-10-31T17:15:00.000Z", "2026-10-31T17:15:00.000Z", "2026-10-31T20:30:00.000Z"]);
  // A one-way trip has no way back: all out.
  assert.deepEqual(legDepartures(1, { start_at_store: true, end_at_store: false }, ev, NOW), ["2026-10-31T17:15:00.000Z"]);
  // Depot -> store before the event (ruling 45): out, not back.
  assert.deepEqual(legDepartures(1, { start_at_store: false, end_at_store: true }, ev, NOW), ["2026-10-31T17:15:00.000Z"]);
});

test("legDepartures: only a trip that left from the store and ends there has a way back", () => {
  const ev: TripTiming = { trip_date: "2026-10-24", event: { date: "2026-10-24", start_time: "14:00", end_time: "16:30" } };
  const allOut = ["2026-10-31T17:15:00.000Z", "2026-10-31T17:15:00.000Z"];
  // Store -> Depot -> venue, not back to the store.
  assert.deepEqual(legDepartures(2, { start_at_store: true, end_at_store: false }, ev, NOW), allOut);
  // Depot -> venue -> store, not from the store.
  assert.deepEqual(legDepartures(2, { start_at_store: false, end_at_store: true }, ev, NOW), allOut);
});

test("legDepartures: no end time comes back at the start; an end after midnight comes back the next day", () => {
  const noEnd: TripTiming = { trip_date: "2026-10-24", event: { date: "2026-10-24", start_time: "14:00", end_time: null } };
  assert.deepEqual(legDepartures(2, BOTH, noEnd, NOW), ["2026-10-31T17:15:00.000Z", "2026-10-31T18:00:00.000Z"]);
  const late: TripTiming = { trip_date: "2026-10-24", event: { date: "2026-10-24", start_time: "22:00", end_time: "01:00" } };
  assert.deepEqual(legDepartures(2, BOTH, late, NOW), ["2026-11-01T01:15:00.000Z", "2026-11-01T05:00:00.000Z"]);
});

test("legDepartures: a Catering Event with no start time is timed like errands, on the trip date's weekday", () => {
  const noStart: TripTiming = { trip_date: "2026-10-20", event: { date: "2026-10-24", start_time: null, end_time: "16:00" } };
  assert.deepEqual(legDepartures(1, BOTH, noStart, NOW), ["2026-11-03T17:00:00.000Z"]);
});

test("legDepartures: never in the past (the Routes API refuses that): a week later if it would be", () => {
  // Friday 00:30 start, asked Thursday 23:50: 23:45 Thursday has gone, so the Friday after.
  const lateNow = new Date("2026-10-30T03:50:00Z");
  const early: TripTiming = { trip_date: "2026-10-23", event: { date: "2026-10-23", start_time: "00:30", end_time: "02:00" } };
  const [out, back] = legDepartures(2, BOTH, early, lateNow);
  assert.equal(out, "2026-11-06T04:45:00.000Z"); // Thu 11-05 23:45 EST
  assert.equal(back, "2026-11-06T07:00:00.000Z"); // Fri 11-06 02:00 EST
  for (const d of [out, back]) assert.ok(Date.parse(d) > lateNow.getTime());
});

test("routeMiles: one traffic-aware Routes API call per leg, each timed, rounded to 0.1 mi, summed", async () => {
  const { calls, fetchImpl } = fakeRoutes([5.26 * MI, 2.04 * MI, 7.25 * MI]);
  const r = await routeMiles(["Venue", "Restaurant Depot"], BOTH, ERRANDS, opts(fetchImpl));
  assert.deepEqual(r, {
    ok: true,
    miles: 14.6,
    legs: [
      { from: STORE_ADDRESS, to: "Venue", miles: 5.3 },
      { from: "Venue", to: "Restaurant Depot", miles: 2 },
      { from: "Restaurant Depot", to: STORE_ADDRESS, miles: 7.3 },
    ],
  });
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.url, ROUTES_ENDPOINT);
    assert.equal(c.headers.get("X-Goog-Api-Key"), "k");
    assert.equal(c.headers.get("X-Goog-FieldMask"), "routes.distanceMeters");
  }
  assert.deepEqual(calls[0].body, {
    origin: { address: STORE_ADDRESS },
    destination: { address: "Venue" },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    departureTime: "2026-11-03T17:00:00.000Z",
    computeAlternativeRoutes: false,
  });
  assert.deepEqual(calls.map((c) => [c.body.origin, c.body.destination]), [
    [{ address: STORE_ADDRESS }, { address: "Venue" }],
    [{ address: "Venue" }, { address: "Restaurant Depot" }],
    [{ address: "Restaurant Depot" }, { address: STORE_ADDRESS }],
  ]);
  for (const c of calls) assert.equal(c.body.intermediates, undefined);
});

test("routeMiles: a Catering Event trip's way out and way back are timed by the event", async () => {
  const { calls, fetchImpl } = fakeRoutes([2.5 * MI, 2.3 * MI]);
  const ev: TripTiming = { trip_date: "2026-10-24", event: { date: "2026-10-24", start_time: "14:00", end_time: "16:30" } };
  const r = await routeMiles(["Venue"], BOTH, ev, opts(fetchImpl));
  assert.equal(r.ok && r.miles, 4.8);
  assert.deepEqual(calls.map((c) => c.body.departureTime), ["2026-10-31T17:15:00.000Z", "2026-10-31T20:30:00.000Z"]);
});

test("routeMiles: a one-way trip is one leg, one call", async () => {
  const { calls, fetchImpl } = fakeRoutes([3 * MI]);
  const r = await routeMiles(["Venue"], { start_at_store: true, end_at_store: false }, ERRANDS, opts(fetchImpl));
  assert.equal(r.ok && r.miles, 3);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.destination, { address: "Venue" });
});

test("routeMiles: not starting at the store routes from the first stop", async () => {
  const { calls, fetchImpl } = fakeRoutes([4 * MI]);
  const r = await routeMiles(["Restaurant Depot"], { start_at_store: false, end_at_store: true }, ERRANDS, opts(fetchImpl));
  assert.deepEqual(r, { ok: true, miles: 4, legs: [{ from: "Restaurant Depot", to: STORE_ADDRESS, miles: 4 }] });
  assert.deepEqual(calls[0].body.origin, { address: "Restaurant Depot" });
  assert.deepEqual(calls[0].body.destination, { address: STORE_ADDRESS });
  const both = fakeRoutes([1 * MI, 2 * MI]);
  const off = await routeMiles(["A", "B", "C"], { start_at_store: false, end_at_store: false }, ERRANDS, opts(both.fetchImpl));
  assert.equal(off.ok && off.miles, 3);
  assert.deepEqual(both.calls.map((c) => [c.body.origin, c.body.destination]), [
    [{ address: "A" }, { address: "B" }],
    [{ address: "B" }, { address: "C" }],
  ]);
});

test("routeMiles: one stop with neither end at the store is refused without calling Google", async () => {
  const { calls, fetchImpl } = fakeRoutes([1 * MI]);
  const r = await routeMiles(["Depot"], { start_at_store: false, end_at_store: false }, ERRANDS, opts(fetchImpl));
  assert.deepEqual(r, { ok: false, error: "A trip needs at least two points." });
  assert.equal(calls.length, 0);
});

test("routeMiles: a leg with no distance (same place twice) is 0 mi", async () => {
  const { fetchImpl } = fakeRoutes([undefined, 1 * MI]);
  const r = await routeMiles(["218 S 40th St", "Venue"], { start_at_store: true, end_at_store: false }, ERRANDS, opts(fetchImpl));
  assert.equal(r.ok && r.miles, 1);
  // The very same address twice is 0 mi without asking Google.
  const same = fakeRoutes([1 * MI]);
  const r2 = await routeMiles([STORE_ADDRESS, "Venue"], { start_at_store: true, end_at_store: false }, ERRANDS, opts(same.fetchImpl));
  assert.deepEqual(r2.ok && r2.legs.map((l) => l.miles), [0, 1]);
  assert.equal(same.calls.length, 1);
});

test("routeMiles: no key, an API error, or no route says so instead of guessing", async () => {
  assert.equal((await routeMiles(["A"], BOTH, ERRANDS, { apiKey: "", fetchImpl: fakeRoutes([1]).fetchImpl, now: NOW })).ok, false);
  const bad = await routeMiles(["A"], BOTH, ERRANDS, opts(fakeRoutes([1], 403).fetchImpl));
  assert.equal(bad.ok, false);
  const none = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
  assert.equal((await routeMiles(["Nowhere"], BOTH, ERRANDS, opts(none))).ok, false);
  // One leg of three with no route refuses the whole trip.
  const oneMissing = await routeMiles(["A", "B"], BOTH, ERRANDS, opts(fakeRoutes([1, 1]).fetchImpl));
  assert.equal(oneMissing.ok, false);
  const offline = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const unreachable = await routeMiles(["A"], BOTH, ERRANDS, opts(offline));
  assert.match(unreachable.ok ? "" : unreachable.error, /could not be reached/);
});
