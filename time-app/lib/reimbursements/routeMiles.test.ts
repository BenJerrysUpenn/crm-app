// Destinations mode (bj-finance #210, rulings 2, 14, 45): the trip starts at
// the store unless "Start at the store" is off, goes through the stops in
// order and ends at the store unless "End at the store" is off; Google's
// Routes API gives each leg's driving distance, each leg is rounded to 0.1 mi
// half-up, and the miles are their sum. Computed on the server only: the key
// never reaches a browser.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { ROUTES_ENDPOINT, STORE_ADDRESS, cleanRoute, cleanStops, placeLabel, routeMiles, routePoints, routeText } from "./routeMiles.ts";

const BOTH = { start_at_store: true, end_at_store: true };

const MI = 1609.344;

function fakeRoutes(legsMeters: (number | undefined)[], status = 200) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status });
    return new Response(JSON.stringify({ routes: [{ legs: legsMeters.map((m) => (m === undefined ? {} : { distanceMeters: m })) }] }), { status: 200 });
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

test("routeMiles: one Routes API call, each leg rounded to 0.1 mi, summed", async () => {
  const { calls, fetchImpl } = fakeRoutes([5.26 * MI, 2.04 * MI, 7.25 * MI]);
  const r = await routeMiles(["Venue", "Restaurant Depot"], BOTH, { apiKey: "k", fetchImpl });
  assert.deepEqual(r, {
    ok: true,
    miles: 14.6,
    legs: [
      { from: STORE_ADDRESS, to: "Venue", miles: 5.3 },
      { from: "Venue", to: "Restaurant Depot", miles: 2 },
      { from: "Restaurant Depot", to: STORE_ADDRESS, miles: 7.3 },
    ],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ROUTES_ENDPOINT);
  assert.equal(calls[0].headers.get("X-Goog-Api-Key"), "k");
  assert.equal(calls[0].headers.get("X-Goog-FieldMask"), "routes.legs.distanceMeters");
  assert.deepEqual(calls[0].body, {
    origin: { address: STORE_ADDRESS },
    destination: { address: STORE_ADDRESS },
    intermediates: [{ address: "Venue" }, { address: "Restaurant Depot" }],
    travelMode: "DRIVE",
    computeAlternativeRoutes: false,
  });
});

test("routeMiles: a one-way trip has no intermediates beyond the middle stops", async () => {
  const { calls, fetchImpl } = fakeRoutes([3 * MI]);
  const r = await routeMiles(["Venue"], { start_at_store: true, end_at_store: false }, { apiKey: "k", fetchImpl });
  assert.equal(r.ok && r.miles, 3);
  assert.deepEqual(calls[0].body.destination, { address: "Venue" });
  assert.equal(calls[0].body.intermediates, undefined);
});

test("routeMiles: not starting at the store routes from the first stop", async () => {
  const { calls, fetchImpl } = fakeRoutes([4 * MI]);
  const r = await routeMiles(["Restaurant Depot"], { start_at_store: false, end_at_store: true }, { apiKey: "k", fetchImpl });
  assert.deepEqual(r, { ok: true, miles: 4, legs: [{ from: "Restaurant Depot", to: STORE_ADDRESS, miles: 4 }] });
  assert.deepEqual(calls[0].body.origin, { address: "Restaurant Depot" });
  assert.deepEqual(calls[0].body.destination, { address: STORE_ADDRESS });
  const both = fakeRoutes([1 * MI, 2 * MI]);
  const off = await routeMiles(["A", "B", "C"], { start_at_store: false, end_at_store: false }, { apiKey: "k", fetchImpl: both.fetchImpl });
  assert.equal(off.ok && off.miles, 3);
  assert.deepEqual(both.calls[0].body.intermediates, [{ address: "B" }]);
});

test("routeMiles: one stop with neither end at the store is refused without calling Google", async () => {
  const { calls, fetchImpl } = fakeRoutes([1 * MI]);
  const r = await routeMiles(["Depot"], { start_at_store: false, end_at_store: false }, { apiKey: "k", fetchImpl });
  assert.deepEqual(r, { ok: false, error: "A trip needs at least two points." });
  assert.equal(calls.length, 0);
});

test("routeMiles: a leg with no distance (same place twice) is 0 mi", async () => {
  const { fetchImpl } = fakeRoutes([undefined, 1 * MI]);
  const r = await routeMiles(["218 S 40th St", "Venue"], { start_at_store: true, end_at_store: false }, { apiKey: "k", fetchImpl });
  assert.equal(r.ok && r.miles, 1);
});

test("routeMiles: no key, an API error, or no route says so instead of guessing", async () => {
  assert.equal((await routeMiles(["A"], BOTH, { apiKey: "", fetchImpl: fakeRoutes([1]).fetchImpl })).ok, false);
  const bad = await routeMiles(["A"], BOTH, { apiKey: "k", fetchImpl: fakeRoutes([1], 403).fetchImpl });
  assert.equal(bad.ok, false);
  const none = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
  assert.equal((await routeMiles(["Nowhere"], BOTH, { apiKey: "k", fetchImpl: none })).ok, false);
  const wrongLegs = await routeMiles(["A", "B"], BOTH, { apiKey: "k", fetchImpl: fakeRoutes([1]).fetchImpl });
  assert.equal(wrongLegs.ok, false);
});
