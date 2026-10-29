// Destinations mode (bj-finance #210, rulings 2, 14, 45): the trip starts at
// the store unless "Start at the store" is off, goes through the stops in
// order and ends at the store unless "End at the store" is off. Each leg is
// its own Routes API call with alternatives on, and pays the shortest of the
// routes Google returns (Alina, 2026-10-29: lean low); each leg is rounded to
// 0.1 mi half-up, and the miles are their sum. Computed on the server only:
// the key never reaches a browser. Every call bills at Compute Routes
// Essentials (Alina, 2026-10-29): traffic-unaware, no intermediates.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { ROUTES_ENDPOINT, STORE_ADDRESS, cleanRoute, cleanStops, placeLabel, routeMiles, routePoints, routeText } from "./routeMiles.ts";

const BOTH = { start_at_store: true, end_at_store: true };

const MI = 1609.344;

/** A stand-in for Google: call i (in the order routeMiles makes them) answers routes perCall[i], each a distance in meters (undefined: left out). */
function fakeRoutes(perCall: (number | undefined)[][], status = 200) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const i = calls.length;
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status });
    const routes = (perCall[i] ?? []).map((m) => (m === undefined ? {} : { distanceMeters: m }));
    return new Response(JSON.stringify(routes.length ? { routes } : {}), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** One route per call, the distances given in miles. */
const oneRouteEach = (...miles: number[]) => miles.map((m) => [m * MI]);

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

test("routeMiles: one Routes API call per leg, each leg rounded to 0.1 mi, summed", async () => {
  const { calls, fetchImpl } = fakeRoutes(oneRouteEach(5.26, 2.04, 7.25));
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
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.url, ROUTES_ENDPOINT);
    assert.equal(c.headers.get("X-Goog-Api-Key"), "k");
    assert.equal(c.headers.get("X-Goog-FieldMask"), "routes.distanceMeters");
  }
  assert.deepEqual(
    calls.map((c) => c.body),
    [
      [STORE_ADDRESS, "Venue"],
      ["Venue", "Restaurant Depot"],
      ["Restaurant Depot", STORE_ADDRESS],
    ].map(([from, to]) => ({ origin: { address: from }, destination: { address: to }, travelMode: "DRIVE", computeAlternativeRoutes: true })),
  );
});

test("routeMiles: each leg pays the shortest of Google's routes, not the default (first) one", async () => {
  // A short city trip: the default outbound takes the expressway (4.0 mi), an alternative stays on the
  // surface streets (3.3 mi); the return has a single route.
  const { fetchImpl } = fakeRoutes([[4.0 * MI, 3.3 * MI, 3.6 * MI], [2.3 * MI]]);
  const r = await routeMiles(["Venue"], BOTH, { apiKey: "k", fetchImpl });
  assert.deepEqual(r, {
    ok: true,
    miles: 5.6,
    legs: [
      { from: STORE_ADDRESS, to: "Venue", miles: 3.3 },
      { from: "Venue", to: STORE_ADDRESS, miles: 2.3 },
    ],
  });
  // Routes that straddle a 0.1 mi rounding step: the default (24.36) would pay 24.4 and the last
  // alternative (24.31) 24.3; the leg pays the shortest, 24.24, rounded: 24.2.
  const close = fakeRoutes([[24.36 * MI, 24.24 * MI, 24.31 * MI]]);
  const one = await routeMiles(["Far venue"], { start_at_store: true, end_at_store: false }, { apiKey: "k", fetchImpl: close.fetchImpl });
  assert.equal(one.ok && one.miles, 24.2);
});

test("routeMiles: a one-way trip is one call, store to the stop", async () => {
  const { calls, fetchImpl } = fakeRoutes(oneRouteEach(3));
  const r = await routeMiles(["Venue"], { start_at_store: true, end_at_store: false }, { apiKey: "k", fetchImpl });
  assert.equal(r.ok && r.miles, 3);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.origin, { address: STORE_ADDRESS });
  assert.deepEqual(calls[0].body.destination, { address: "Venue" });
  assert.equal("intermediates" in calls[0].body, false);
});

test("routeMiles: not starting at the store routes from the first stop", async () => {
  const { calls, fetchImpl } = fakeRoutes(oneRouteEach(4));
  const r = await routeMiles(["Restaurant Depot"], { start_at_store: false, end_at_store: true }, { apiKey: "k", fetchImpl });
  assert.deepEqual(r, { ok: true, miles: 4, legs: [{ from: "Restaurant Depot", to: STORE_ADDRESS, miles: 4 }] });
  assert.deepEqual(calls[0].body.origin, { address: "Restaurant Depot" });
  assert.deepEqual(calls[0].body.destination, { address: STORE_ADDRESS });
  const both = fakeRoutes(oneRouteEach(1, 2));
  const off = await routeMiles(["A", "B", "C"], { start_at_store: false, end_at_store: false }, { apiKey: "k", fetchImpl: both.fetchImpl });
  assert.equal(off.ok && off.miles, 3);
  assert.deepEqual(
    both.calls.map((c) => [c.body.origin, c.body.destination]),
    [
      [{ address: "A" }, { address: "B" }],
      [{ address: "B" }, { address: "C" }],
    ],
  );
});

test("routeMiles: one stop with neither end at the store is refused without calling Google", async () => {
  const { calls, fetchImpl } = fakeRoutes(oneRouteEach(1));
  const r = await routeMiles(["Depot"], { start_at_store: false, end_at_store: false }, { apiKey: "k", fetchImpl });
  assert.deepEqual(r, { ok: false, error: "A trip needs at least two points." });
  assert.equal(calls.length, 0);
});

test("routeMiles: a leg with no distance (same place twice) is 0 mi", async () => {
  const { fetchImpl } = fakeRoutes([[undefined], [1 * MI]]);
  const r = await routeMiles(["218 S 40th St", "Venue"], { start_at_store: true, end_at_store: false }, { apiKey: "k", fetchImpl });
  assert.equal(r.ok && r.miles, 1);
});

test("routeMiles: no key, an API error, or no route on any leg says so instead of guessing", async () => {
  const noKey = fakeRoutes(oneRouteEach(1, 1));
  assert.equal((await routeMiles(["A"], BOTH, { apiKey: "", fetchImpl: noKey.fetchImpl })).ok, false);
  assert.equal(noKey.calls.length, 0);
  const bad = await routeMiles(["A"], BOTH, { apiKey: "k", fetchImpl: fakeRoutes(oneRouteEach(1, 1), 403).fetchImpl });
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.error : "", /HTTP 403/);
  const none = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
  assert.equal((await routeMiles(["Nowhere"], BOTH, { apiKey: "k", fetchImpl: none })).ok, false);
  // An explicit empty list is no route too, not a leg of some made-up length.
  const empty = (async () => new Response(JSON.stringify({ routes: [] }), { status: 200 })) as unknown as typeof fetch;
  const emptyResult = await routeMiles(["Nowhere"], BOTH, { apiKey: "k", fetchImpl: empty });
  assert.match(!emptyResult.ok ? emptyResult.error : "", /no driving route/);
  // The outbound routes, the return does not: the trip is refused, not paid one way.
  const halfway = await routeMiles(["A"], BOTH, { apiKey: "k", fetchImpl: fakeRoutes([[1 * MI], []]).fetchImpl });
  assert.equal(halfway.ok, false);
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const unreachable = await routeMiles(["A"], BOTH, { apiKey: "k", fetchImpl: down });
  assert.match(!unreachable.ok ? unreachable.error : "", /could not be reached/);
});

test("routeMiles: every call stays on Compute Routes Essentials (no traffic-aware routing, no Pro or Enterprise feature)", async () => {
  // The most stops a trip may carry, both ends at the store: 11 legs, so 11 calls, each origin and
  // destination only. Pro: 11 to 25 intermediates, routingPreference TRAFFIC_AWARE(_OPTIMAL),
  // optimizeWaypointOrder, side of road / heading / vehicle stopover. Real-time traffic: departureTime.
  // Enterprise: tolls and traffic on polylines (extraComputations), two-wheeler, large vehicle.
  // computeAlternativeRoutes is on neither list (developers.google.com/maps/billing-and-pricing/sku-details).
  const stops = Array.from({ length: 10 }, (_, i) => `Stop ${i + 1}`);
  assert.equal(cleanRoute(stops, BOTH).ok, true);
  assert.equal(cleanRoute([...stops, "Stop 11"], BOTH).ok, false);
  const { calls, fetchImpl } = fakeRoutes(Array.from({ length: 11 }, () => [1.2 * MI, 1 * MI]));
  const r = await routeMiles(stops, BOTH, { apiKey: "k", fetchImpl });
  assert.equal(r.ok && r.miles, 11);
  assert.equal(calls.length, 11);
  for (const { body, headers } of calls) {
    assert.deepEqual(Object.keys(body).sort(), ["computeAlternativeRoutes", "destination", "origin", "travelMode"]);
    assert.equal(body.travelMode, "DRIVE");
    assert.equal(body.computeAlternativeRoutes, true);
    for (const w of [body.origin, body.destination]) assert.deepEqual(Object.keys(w as object), ["address"]);
    assert.equal(headers.get("X-Goog-FieldMask"), "routes.distanceMeters");
  }
});
