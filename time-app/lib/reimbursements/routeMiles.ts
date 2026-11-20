// Mileage from destinations (bj-finance #210, rulings 2, 14, 45).
//
// The trip starts at the store unless the staff member turns "Start at the
// store" off (then it starts at the first stop: home -> Restaurant Depot ->
// store is entered as Restaurant Depot, then the store, and only that is
// paid), visits the stops in order, and ends at the store unless "End at the
// store" is off. With both off it is just the stops. Two points at least.
//
// Each leg pays the LOWER of two Google Routes API (computeRoutes, DRIVE)
// answers, asked for in parallel (Alina, 2026-10-29: staff payouts lean low,
// never overpay; typed miles stay and are preferred when staff have them):
//   (a) the leg on its own, computeAlternativeRoutes on: the shortest of the
//       routes Google returns, its default plus up to three alternatives.
//       Google's default favors time and on short city trips takes the
//       expressway, so it runs long.
//   (b) the leg's distance on Google's default route through every point in
//       one request (the stops as intermediates), as miles were paid before.
//       On some legs it is the shorter of the two (a return leg of 2.4 mi
//       against 2.6 mi from (a) on a real trip), so no leg pays more than (b).
// Alternatives need a request per leg because Google returns none for a
// request with intermediates
// (developers.google.com/maps/documentation/routes/alternative-routes, and
// the computeAlternativeRoutes field in the computeRoutes REST reference).
// If (b) fails, every leg pays (a); if a leg's (a) fails, that leg pays (b);
// if both fail for any leg, the trip is refused and staff type the miles.
// Each leg is rounded to 0.1 mi half-up after the choice
// (lib/reimbursements/money.ts) and the miles are their sum.
//
// Billing (Alina's ruling, 2026-10-29): every request stays on the Compute
// Routes Essentials SKU. Google moves a request to Pro for 11 to 25
// intermediates, optimizeWaypointOrder, routingPreference TRAFFIC_AWARE or
// TRAFFIC_AWARE_OPTIMAL, or a side of road, heading or vehicle stopover
// modifier; to Enterprise for toll calculation, traffic on polylines,
// two-wheeler or large vehicle routing
// (developers.google.com/maps/billing-and-pricing/sku-details).
// computeAlternativeRoutes is not on either list. So no request sets any of
// those: (a) is an origin and a destination only, field mask
// routes.distanceMeters; (b) has at most MAX_STOPS (10) intermediates, field
// mask routes.legs.distanceMeters; neither sets routingPreference (the default
// is traffic-unaware) or departureTime, and every waypoint is an address only.
// A trip bills one Essentials request per leg plus one, at most MAX_STOPS + 2.
//
// Server-only in practice: the key is GOOGLE_MAPS_API_KEY, read by the route
// that calls this, and never sent to a browser. Pure apart from the injected
// fetch, so `node --test` drives it with a stand-in.

import { legMiles, sumMiles } from "./money.ts";

export const STORE_ADDRESS = "218 S 40th St, Philadelphia, PA 19104";
export const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
/** The most stops a trip may carry: at most 10 intermediates in (b), Essentials' ceiling, and 12 requests a trip. */
export const MAX_STOPS = 10;
const MAX_STOP_LENGTH = 300;

export type Leg = { from: string; to: string; miles: number };
/** The two checkboxes of destinations mode, both on by default. */
export type RouteEnds = { start_at_store: boolean; end_at_store: boolean };

/** The checkboxes as a body or a row carries them: each one on unless it is false. */
export function routeEnds(raw: { start_at_store?: unknown; end_at_store?: unknown } | null | undefined): RouteEnds {
  return { start_at_store: raw?.start_at_store !== false, end_at_store: raw?.end_at_store !== false };
}
export type RouteResult = { ok: true; miles: number; legs: Leg[] } | { ok: false; error: string };

/** The stops as typed: trimmed, blanks dropped; at least one, at most MAX_STOPS. */
export function cleanStops(input: unknown): { ok: true; stops: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Add at least one stop." };
  const stops = input.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s !== "");
  if (stops.length === 0) return { ok: false, error: "Add at least one stop." };
  if (stops.length > MAX_STOPS) return { ok: false, error: `At most ${MAX_STOPS} stops.` };
  if (stops.some((s) => s.length > MAX_STOP_LENGTH)) return { ok: false, error: "A stop's address is too long." };
  return { ok: true, stops };
}

/** Every point of the trip, in order: the store if starting there, the stops, the store if ending there. */
export function routePoints(stops: string[], ends: RouteEnds): string[] {
  return [...(ends.start_at_store ? [STORE_ADDRESS] : []), ...stops, ...(ends.end_at_store ? [STORE_ADDRESS] : [])];
}

/** cleanStops, and the trip has at least two points: with neither end at the store, two stops. */
export function cleanRoute(input: unknown, ends: RouteEnds): { ok: true; stops: string[] } | { ok: false; error: string } {
  const stops = cleanStops(input);
  if (!stops.ok) return stops;
  if (routePoints(stops.stops, ends).length < 2)
    return { ok: false, error: "Not starting or ending at the store: enter at least two stops, where you started and where you went." };
  return stops;
}

/** The store as staff see it in legs and routes: "Store", not its address. */
export function placeLabel(address: string): string {
  return address === STORE_ADDRESS ? "Store" : address;
}

/** The trip as one line, e.g. "Store → Venue → Store". */
export function routeText(stops: string[], ends: RouteEnds): string {
  return routePoints(stops, ends).map(placeLabel).join(" → ");
}

type Answer<T> = { ok: true; value: T } | { ok: false; error: string };

/** One computeRoutes request: Google's JSON, or the "type the miles" error for an HTTP error or no answer. */
async function computeRoutes<T>(
  body: Record<string, unknown>,
  fieldMask: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<Answer<T>> {
  try {
    const res = await fetchImpl(ROUTES_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": fieldMask },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: `Google could not route that trip (HTTP ${res.status}). Check the addresses, or type the miles.` };
    return { ok: true, value: (await res.json()) as T };
  } catch {
    return { ok: false, error: "Google Maps could not be reached. Try again, or type the miles." };
  }
}

const NO_ROUTE = "Google found no driving route through those stops. Check the addresses, or type the miles.";

/** (a) One leg's driving distance in meters: the shortest of Google's routes from `from` to `to`. */
async function shortestLegMeters(
  { from, to }: Omit<Leg, "miles">,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<Answer<number>> {
  const r = await computeRoutes<{ routes?: { distanceMeters?: number }[] }>(
    { origin: { address: from }, destination: { address: to }, travelMode: "DRIVE", computeAlternativeRoutes: true },
    "routes.distanceMeters",
    apiKey,
    fetchImpl,
  );
  if (!r.ok) return r;
  const routes = r.value.routes;
  if (!routes || routes.length === 0) return { ok: false, error: NO_ROUTE };
  // A route with no distanceMeters is 0 m: the JSON leaves a zero out (same place twice).
  return { ok: true, value: Math.min(...routes.map((x) => x.distanceMeters ?? 0)) };
}

/** (b) Every leg's driving distance in meters on Google's default route through all the points in one request. */
async function tripLegMeters(points: string[], apiKey: string, fetchImpl: typeof fetch): Promise<Answer<number[]>> {
  const body: Record<string, unknown> = {
    origin: { address: points[0] },
    destination: { address: points[points.length - 1] },
    travelMode: "DRIVE",
    computeAlternativeRoutes: false,
  };
  const middle = points.slice(1, -1);
  if (middle.length) body.intermediates = middle.map((address) => ({ address }));
  const r = await computeRoutes<{ routes?: { legs?: { distanceMeters?: number }[] }[] }>(
    body,
    "routes.legs.distanceMeters",
    apiKey,
    fetchImpl,
  );
  if (!r.ok) return r;
  const legs = r.value.routes?.[0]?.legs;
  if (!legs || legs.length !== points.length - 1) return { ok: false, error: NO_ROUTE };
  return { ok: true, value: legs.map((l) => l.distanceMeters ?? 0) };
}

export async function routeMiles(
  stops: string[],
  ends: RouteEnds,
  opts: { apiKey: string | undefined; fetchImpl?: typeof fetch },
): Promise<RouteResult> {
  if (!opts.apiKey) return { ok: false, error: "Computing miles from destinations is not set up yet (no Maps key). Type the miles instead." };
  const points = routePoints(stops, ends);
  if (points.length < 2) return { ok: false, error: "A trip needs at least two points." };
  const apiKey = opts.apiKey;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pairs = points.slice(1).map((to, i) => ({ from: points[i], to }));
  const [trip, perLeg] = await Promise.all([
    tripLegMeters(points, apiKey, fetchImpl),
    Promise.all(pairs.map((p) => shortestLegMeters(p, apiKey, fetchImpl))),
  ]);
  const out: Leg[] = [];
  for (const [i, shortest] of perLeg.entries()) {
    // Neither answer for this leg: the whole trip is refused, never paid in part.
    if (!shortest.ok && !trip.ok) return shortest;
    // The lower of the two this leg has, rounded after the choice.
    const meters = Math.min(shortest.ok ? shortest.value : Infinity, trip.ok ? trip.value[i] : Infinity);
    out.push({ ...pairs[i], miles: legMiles(meters) });
  }
  return { ok: true, miles: sumMiles(out.map((l) => l.miles)), legs: out };
}
