// Mileage from destinations (bj-finance #210, rulings 2, 14, 45).
//
// The trip starts at the store unless the staff member turns "Start at the
// store" off (then it starts at the first stop: home -> Restaurant Depot ->
// store is entered as Restaurant Depot, then the store, and only that is
// paid), visits the stops in order, and ends at the store unless "End at the
// store" is off. With both off it is just the stops. Two points at least. Each
// leg (store -> first stop, stop -> stop, last stop -> store) is its own
// Google Routes API call (computeRoutes, DRIVE, computeAlternativeRoutes on),
// and the leg pays the shortest driving distance among the routes Google
// returns: its default route plus up to three alternatives. Google's default
// favors time, so on short city trips it takes the expressway and runs long;
// the shortest route keeps staff payouts from running high (Alina, 2026-10-29:
// as accurate as possible, lean low rather than high; typed miles stay and are
// preferred when staff have them). Each leg is rounded to 0.1 mi half-up
// (lib/reimbursements/money.ts) and the miles are their sum. Alternatives are
// a call per leg because Google returns none for a request with intermediates
// (developers.google.com/maps/documentation/routes/alternative-routes, and the
// computeAlternativeRoutes field in the computeRoutes REST reference).
//
// Billing (Alina's ruling, 2026-10-29): every call stays on the Compute Routes
// Essentials SKU. Google moves a request to Pro for 11 to 25 intermediates,
// optimizeWaypointOrder, routingPreference TRAFFIC_AWARE or
// TRAFFIC_AWARE_OPTIMAL, or a side of road, heading or vehicle stopover
// modifier; to Enterprise for toll calculation, traffic on polylines,
// two-wheeler or large vehicle routing
// (developers.google.com/maps/billing-and-pricing/sku-details).
// computeAlternativeRoutes is not on either list. So each request sets none of
// those: an origin and a destination only (no intermediates), no
// routingPreference (the default is traffic-unaware), no departureTime, and a
// field mask of routes.distanceMeters only. A trip bills one Essentials
// request per leg, at most MAX_STOPS + 1.
//
// Server-only in practice: the key is GOOGLE_MAPS_API_KEY, read by the route
// that calls this, and never sent to a browser. Pure apart from the injected
// fetch, so `node --test` drives it with a stand-in.

import { legMiles, sumMiles } from "./money.ts";

export const STORE_ADDRESS = "218 S 40th St, Philadelphia, PA 19104";
export const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
/** The most stops a trip may carry, so a trip makes at most 11 calls, one per leg. */
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

/** One leg's driving distance in meters: the shortest of Google's routes from `from` to `to`. */
async function legMeters(
  from: string,
  to: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; meters: number } | { ok: false; error: string }> {
  let payload: { routes?: { distanceMeters?: number }[] };
  try {
    const res = await fetchImpl(ROUTES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.distanceMeters",
      },
      body: JSON.stringify({
        origin: { address: from },
        destination: { address: to },
        travelMode: "DRIVE",
        computeAlternativeRoutes: true,
      }),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: `Google could not route that trip (HTTP ${res.status}). Check the addresses, or type the miles.` };
    payload = await res.json();
  } catch {
    return { ok: false, error: "Google Maps could not be reached. Try again, or type the miles." };
  }
  const routes = payload.routes;
  if (!routes || routes.length === 0)
    return { ok: false, error: "Google found no driving route through those stops. Check the addresses, or type the miles." };
  // A route with no distanceMeters is 0 m: the JSON leaves a zero out (same place twice).
  return { ok: true, meters: Math.min(...routes.map((r) => r.distanceMeters ?? 0)) };
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
  const results = await Promise.all(pairs.map((p) => legMeters(p.from, p.to, apiKey, fetchImpl)));
  const out: Leg[] = [];
  for (const [i, r] of results.entries()) {
    if (!r.ok) return r;
    out.push({ ...pairs[i], miles: legMiles(r.meters) });
  }
  return { ok: true, miles: sumMiles(out.map((l) => l.miles)), legs: out };
}
