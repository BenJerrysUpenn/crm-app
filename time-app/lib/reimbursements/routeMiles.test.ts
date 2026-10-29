// Destinations mode (bj-finance #210, rulings 2, 14, 45): the trip starts at
// the store unless "Start at the store" is off, goes through the stops in
// order and ends at the store unless "End at the store" is off. Each leg pays
// the lower of (a) the shortest of Google's routes for the leg on its own
// (alternatives on) and (b) the leg on Google's default route through every
// point in one request (Alina, 2026-10-29: lean low, never overpay); each leg
// is rounded to 0.1 mi half-up after the choice, and the miles are their sum.
// Computed on the server only: the key never reaches a browser. Every request
// bills at Compute Routes Essentials (Alina, 2026-10-29).
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { ROUTES_ENDPOINT, STORE_ADDRESS, cleanRoute, cleanStops, placeLabel, routeMiles, routePoints, routeText } from "./routeMiles.ts";

const BOTH = { start_at_store: true, end_at_store: true };

const MI = 1609.344;

/** How the stand-in answers one request: distances in meters (undefined: left out), an HTTP status, or "down" (fetch throws). */
type Answer = (number | undefined)[] | number | "down";

/**
 * A stand-in for Google. The whole-trip request (b), the one with computeAlternativeRoutes false,
 * answers `trip` as its route's legs; the per-leg requests (a) answer `legs[i]` as routes, in the
 * order routeMiles makes them.
 */
function fakeGoogle({ trip, legs }: { trip: Answer; legs: Answer[] }) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  let leg = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), headers: new Headers(init?.headers), body });
    const whole = body.computeAlternativeRoutes === false;
    const answer = whole ? trip : legs[leg++];
    if (answer === "down") throw new TypeError("fetch failed");
    if (typeof answer === "number") return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: answer });
    const each = (answer ?? []).map((m) => (m === undefined ? {} : { distanceMeters: m }));
    const payload = each.length === 0 ? {} : whole ? { routes: [{ legs: each }] } : { routes: each };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  const isTrip = (c: (typeof calls)[number]) => c.body.computeAlternativeRoutes === false;
  return { calls, fetchImpl, tripCalls: () => calls.filter(isTrip), legCalls: () => calls.filter((c) => !isTrip(c)) };
}

/** Miles to meters, one route per leg request. */
const oneRouteEach = (...miles: number[]) => miles.map((m) => [m * MI]);
/** Miles to meters, the whole-trip request's legs. */
const tripLegs = (...miles: number[]) => miles.map((m) => m * MI);

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

test("routeMiles: a request per leg (a) and one whole-trip request (b), each leg rounded to 0.1 mi, summed", async () => {
  const g = fakeGoogle({ trip: tripLegs(5.3, 2.1, 7.3), legs: oneRouteEach(5.26, 2.04, 7.25) });
  const r = await routeMiles(["Venue", "Restaurant Depot"], BOTH, { apiKey: "k", fetchImpl: g.fetchImpl });
  assert.deepEqual(r, {
    ok: true,
    miles: 14.6,
    legs: [
      { from: STORE_ADDRESS, to: "Venue", miles: 5.3 },
      { from: "Venue", to: "Restaurant Depot", miles: 2 },
      { from: "Restaurant Depot", to: STORE_ADDRESS, miles: 7.3 },
    ],
  });
  assert.equal(g.calls.length, 4);
  for (const c of g.calls) {
    assert.equal(c.url, ROUTES_ENDPOINT);
    assert.equal(c.headers.get("X-Goog-Api-Key"), "k");
  }
  assert.deepEqual(
    g.legCalls().map((c) => c.body),
    [
      [STORE_ADDRESS, "Venue"],
      ["Venue", "Restaurant Depot"],
      ["Restaurant Depot", STORE_ADDRESS],
    ].map(([from, to]) => ({ origin: { address: from }, destination: { address: to }, travelMode: "DRIVE", computeAlternativeRoutes: true })),
  );
  for (const c of g.legCalls()) assert.equal(c.headers.get("X-Goog-FieldMask"), "routes.distanceMeters");
  assert.deepEqual(
    g.tripCalls().map((c) => c.body),
    [
      {
        origin: { address: STORE_ADDRESS },
        destination: { address: STORE_ADDRESS },
        travelMode: "DRIVE",
        computeAlternativeRoutes: false,
        intermediates: [{ address: "Venue" }, { address: "Restaurant Depot" }],
      },
    ],
  );
  assert.equal(g.tripCalls()[0].headers.get("X-Goog-FieldMask"), "routes.legs.distanceMeters");
});

test("routeMiles: each leg pays the lower of its shortest alternative (a) and its whole-trip distance (b)", async () => {
  // A short city trip. Outbound: the default takes the expressway (4.0), an alternative stays on the
  // surface streets (3.3), the whole-trip route says 3.5: pays 3.3 from (a). Return: (a) has a single
  // route of 2.6, the whole-trip route says 2.4: pays 2.4 from (b), never more than (b).
  const g = fakeGoogle({ trip: tripLegs(3.5, 2.4), legs: [[4.0 * MI, 3.3 * MI, 3.6 * MI], [2.6 * MI]] });
  const r = await routeMiles(["Venue"], BOTH, { apiKey: "k", fetchImpl: g.fetchImpl });
  assert.deepEqual(r, {
    ok: true,
    miles: 5.7,
    legs: [
      { from: STORE_ADDRESS, to: "Venue", miles: 3.3 },
      { from: "Venue", to: STORE_ADDRESS, miles: 2.4 },
    ],
  });
});

test("routeMiles: the leg pays the lower distance rounded to 0.1 mi, across a rounding step", async () => {
  const oneWay = { start_at_store: true, end_at_store: false };
  // (a) lower: Google's default 24.36 would pay 24.4 and (b) 24.26 would pay 24.3; the shortest
  // alternative is 24.24, so the leg pays 24.2.
  const first = fakeGoogle({ trip: tripLegs(24.26), legs: [[24.36 * MI, 24.24 * MI, 24.31 * MI]] });
  const a = await routeMiles(["Far venue"], oneWay, { apiKey: "k", fetchImpl: first.fetchImpl });
  assert.equal(a.ok && a.miles, 24.2);
  // (b) lower: (a)'s only route 24.36 would pay 24.4; (b) is 24.24, so the leg pays 24.2.
  const second = fakeGoogle({ trip: tripLegs(24.24), legs: [[24.36 * MI]] });
  const b = await routeMiles(["Far venue"], oneWay, { apiKey: "k", fetchImpl: second.fetchImpl });
  assert.equal(b.ok && b.miles, 24.2);
});

test("routeMiles: when the whole-trip request (b) fails, every leg pays its shortest alternative (a)", async () => {
  const legs = [[4.0 * MI, 3.3 * MI], [2.6 * MI]];
  const want = { ok: true, miles: 5.9, legs: [{ from: STORE_ADDRESS, to: "Venue", miles: 3.3 }, { from: "Venue", to: STORE_ADDRESS, miles: 2.6 }] };
  // An HTTP error, Google unreachable, no route at all, and a route with the wrong number of legs.
  for (const trip of [500, "down", [], tripLegs(6)] as Answer[]) {
    const g = fakeGoogle({ trip, legs });
    assert.deepEqual(await routeMiles(["Venue"], BOTH, { apiKey: "k", fetchImpl: g.fetchImpl }), want, `trip answered ${JSON.stringify(trip)}`);
  }
});

test("routeMiles: when a leg's own request (a) fails, that leg pays its whole-trip distance (b)", async () => {
  // Outbound (a) fails in each way; the return still pays the lower of the two.
  for (const out of [403, "down", []] as Answer[]) {
    const g = fakeGoogle({ trip: tripLegs(3.5, 2.4), legs: [out, [2.6 * MI]] });
    assert.deepEqual(
      await routeMiles(["Venue"], BOTH, { apiKey: "k", fetchImpl: g.fetchImpl }),
      { ok: true, miles: 5.9, legs: [{ from: STORE_ADDRESS, to: "Venue", miles: 3.5 }, { from: "Venue", to: STORE_ADDRESS, miles: 2.4 }] },
      `outbound answered ${JSON.stringify(out)}`,
    );
  }
});

test("routeMiles: a leg with neither answer refuses the whole trip, never pays it in part", async () => {
  // The outbound routes on its own, the return does not, and the whole-trip request fails.
  const halfway = await routeMiles(["A"], BOTH, { apiKey: "k", fetchImpl: fakeGoogle({ trip: 500, legs: [[1 * MI], []] }).fetchImpl });
  assert.deepEqual(halfway, { ok: false, error: "Google found no driving route through those stops. Check the addresses, or type the miles." });
  const bad = await routeMiles(["A"], BOTH, { apiKey: "k", fetchImpl: fakeGoogle({ trip: 403, legs: [403, 403] }).fetchImpl });
  assert.match(!bad.ok ? bad.error : "", /HTTP 403.*type the miles/);
  const down = await routeMiles(["A"], BOTH, { apiKey: "k", fetchImpl: fakeGoogle({ trip: "down", legs: ["down", "down"] }).fetchImpl });
  assert.match(!down.ok ? down.error : "", /could not be reached.*type the miles/);
  // An explicit empty list is no route too, not a leg of some made-up length.
  const empty = (async () => new Response(JSON.stringify({ routes: [] }), { status: 200 })) as unknown as typeof fetch;
  const emptyResult = await routeMiles(["Nowhere"], BOTH, { apiKey: "k", fetchImpl: empty });
  assert.match(!emptyResult.ok ? emptyResult.error : "", /no driving route/);
});

test("routeMiles: a one-way trip is one leg request and a whole-trip request with no intermediates", async () => {
  const g = fakeGoogle({ trip: tripLegs(3), legs: oneRouteEach(3) });
  const r = await routeMiles(["Venue"], { start_at_store: true, end_at_store: false }, { apiKey: "k", fetchImpl: g.fetchImpl });
  assert.equal(r.ok && r.miles, 3);
  assert.equal(g.calls.length, 2);
  for (const c of g.calls) {
    assert.deepEqual(c.body.origin, { address: STORE_ADDRESS });
    assert.deepEqual(c.body.destination, { address: "Venue" });
    assert.equal("intermediates" in c.body, false);
  }
});

test("routeMiles: not starting at the store routes from the first stop", async () => {
  const g = fakeGoogle({ trip: tripLegs(4), legs: oneRouteEach(4) });
  const r = await routeMiles(["Restaurant Depot"], { start_at_store: false, end_at_store: true }, { apiKey: "k", fetchImpl: g.fetchImpl });
  assert.deepEqual(r, { ok: true, miles: 4, legs: [{ from: "Restaurant Depot", to: STORE_ADDRESS, miles: 4 }] });
  assert.deepEqual(g.legCalls()[0].body.origin, { address: "Restaurant Depot" });
  assert.deepEqual(g.legCalls()[0].body.destination, { address: STORE_ADDRESS });
  const both = fakeGoogle({ trip: tripLegs(1, 2), legs: oneRouteEach(1, 2) });
  const off = await routeMiles(["A", "B", "C"], { start_at_store: false, end_at_store: false }, { apiKey: "k", fetchImpl: both.fetchImpl });
  assert.equal(off.ok && off.miles, 3);
  assert.deepEqual(
    both.legCalls().map((c) => [c.body.origin, c.body.destination]),
    [
      [{ address: "A" }, { address: "B" }],
      [{ address: "B" }, { address: "C" }],
    ],
  );
  const trip = both.tripCalls()[0].body;
  assert.deepEqual([trip.origin, trip.intermediates, trip.destination], [{ address: "A" }, [{ address: "B" }], { address: "C" }]);
});

test("routeMiles: one stop with neither end at the store is refused without calling Google", async () => {
  const g = fakeGoogle({ trip: tripLegs(1), legs: oneRouteEach(1) });
  const r = await routeMiles(["Depot"], { start_at_store: false, end_at_store: false }, { apiKey: "k", fetchImpl: g.fetchImpl });
  assert.deepEqual(r, { ok: false, error: "A trip needs at least two points." });
  assert.equal(g.calls.length, 0);
});

test("routeMiles: a leg with no distance (same place twice) is 0 mi, from either request", async () => {
  const oneWay = { start_at_store: true, end_at_store: false };
  const want = {
    ok: true,
    miles: 1,
    legs: [
      { from: STORE_ADDRESS, to: "218 S 40th St", miles: 0 },
      { from: "218 S 40th St", to: "Venue", miles: 1 },
    ],
  };
  // Only (a) answers the first leg (the whole-trip request fails), and leaves its distance out.
  const a = fakeGoogle({ trip: 500, legs: [[undefined], [1 * MI]] });
  assert.deepEqual(await routeMiles(["218 S 40th St", "Venue"], oneWay, { apiKey: "k", fetchImpl: a.fetchImpl }), want);
  // Only (b) answers the first leg (its own request is down), and leaves its distance out.
  const b = fakeGoogle({ trip: [undefined, 1 * MI], legs: ["down", [1 * MI]] });
  assert.deepEqual(await routeMiles(["218 S 40th St", "Venue"], oneWay, { apiKey: "k", fetchImpl: b.fetchImpl }), want);
});

test("routeMiles: no key says so without calling Google", async () => {
  const g = fakeGoogle({ trip: tripLegs(1, 1), legs: oneRouteEach(1, 1) });
  assert.equal((await routeMiles(["A"], BOTH, { apiKey: "", fetchImpl: g.fetchImpl })).ok, false);
  assert.equal(g.calls.length, 0);
});

test("routeMiles: every request stays on Compute Routes Essentials (no traffic-aware routing, no Pro or Enterprise feature)", async () => {
  // The most stops a trip may carry, both ends at the store: 11 legs, so 11 leg requests with origin
  // and destination only, and one whole-trip request with 10 intermediates, Essentials' ceiling.
  // Pro: 11 to 25 intermediates, routingPreference TRAFFIC_AWARE(_OPTIMAL), optimizeWaypointOrder,
  // side of road / heading / vehicle stopover. Real-time traffic: departureTime. Enterprise: tolls
  // and traffic on polylines (extraComputations), two-wheeler, large vehicle.
  // computeAlternativeRoutes is on neither list (developers.google.com/maps/billing-and-pricing/sku-details).
  const stops = Array.from({ length: 10 }, (_, i) => `Stop ${i + 1}`);
  assert.equal(cleanRoute(stops, BOTH).ok, true);
  assert.equal(cleanRoute([...stops, "Stop 11"], BOTH).ok, false);
  const g = fakeGoogle({ trip: Array.from({ length: 11 }, () => 1.1 * MI), legs: Array.from({ length: 11 }, () => [1.2 * MI, 1 * MI]) });
  const r = await routeMiles(stops, BOTH, { apiKey: "k", fetchImpl: g.fetchImpl });
  assert.equal(r.ok && r.miles, 11);
  assert.equal(g.calls.length, 12);
  assert.equal(g.legCalls().length, 11);
  for (const { body, headers } of g.legCalls()) {
    assert.deepEqual(Object.keys(body).sort(), ["computeAlternativeRoutes", "destination", "origin", "travelMode"]);
    assert.equal(body.travelMode, "DRIVE");
    assert.equal(body.computeAlternativeRoutes, true);
    for (const w of [body.origin, body.destination]) assert.deepEqual(Object.keys(w as object), ["address"]);
    assert.equal(headers.get("X-Goog-FieldMask"), "routes.distanceMeters");
  }
  assert.equal(g.tripCalls().length, 1);
  const [{ body, headers }] = g.tripCalls();
  assert.deepEqual(Object.keys(body).sort(), ["computeAlternativeRoutes", "destination", "intermediates", "origin", "travelMode"]);
  assert.equal(body.travelMode, "DRIVE");
  assert.equal(body.computeAlternativeRoutes, false);
  const intermediates = body.intermediates as object[];
  assert.equal(intermediates.length, 10);
  for (const w of [body.origin, body.destination, ...intermediates]) assert.deepEqual(Object.keys(w as object), ["address"]);
  assert.equal(headers.get("X-Goog-FieldMask"), "routes.legs.distanceMeters");
});
