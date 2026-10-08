// Mileage from destinations (bj-finance #210, rulings 2, 14).
//
// The trip starts at the store, visits the stops in order and, unless the
// staff member turns "Return to start" off, comes back to the store. Google's
// Routes API (computeRoutes, DRIVE) gives each leg's driving distance in one
// call; each leg is rounded to 0.1 mi half-up (lib/reimbursements/money.ts) and
// the miles are their sum. The reference is catering-automations
// modules/maps.py, which prices a deal's delivery the same way.
//
// Server-only in practice: the key is GOOGLE_MAPS_API_KEY, read by the route
// that calls this, and never sent to a browser. Pure apart from the injected
// fetch, so `node --test` drives it with a stand-in.

import { legMiles, sumMiles } from "./money.ts";

export const STORE_ADDRESS = "218 S 40th St, Philadelphia, PA 19104";
export const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
export const MAX_STOPS = 10;
const MAX_STOP_LENGTH = 300;

export type Leg = { from: string; to: string; miles: number };
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

/** Every point of the trip, in order: the store, the stops, the store again if returning. */
export function routePoints(stops: string[], returnToStart: boolean): string[] {
  return [STORE_ADDRESS, ...stops, ...(returnToStart ? [STORE_ADDRESS] : [])];
}

export async function routeMiles(
  stops: string[],
  returnToStart: boolean,
  opts: { apiKey: string | undefined; fetchImpl?: typeof fetch },
): Promise<RouteResult> {
  if (!opts.apiKey) return { ok: false, error: "Computing miles from destinations is not set up yet (no Maps key). Type the miles instead." };
  const points = routePoints(stops, returnToStart);
  const body: Record<string, unknown> = {
    origin: { address: points[0] },
    destination: { address: points[points.length - 1] },
    travelMode: "DRIVE",
    computeAlternativeRoutes: false,
  };
  const middle = points.slice(1, -1);
  if (middle.length) body.intermediates = middle.map((address) => ({ address }));

  let payload: { routes?: { legs?: { distanceMeters?: number }[] }[] };
  try {
    const res = await (opts.fetchImpl ?? fetch)(ROUTES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": opts.apiKey,
        "X-Goog-FieldMask": "routes.legs.distanceMeters",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: `Google could not route that trip (HTTP ${res.status}). Check the addresses, or type the miles.` };
    payload = await res.json();
  } catch {
    return { ok: false, error: "Google Maps could not be reached. Try again, or type the miles." };
  }
  const legs = payload.routes?.[0]?.legs;
  if (!legs || legs.length !== points.length - 1)
    return { ok: false, error: "Google found no driving route through those stops. Check the addresses, or type the miles." };
  const out = legs.map((l, i) => ({ from: points[i], to: points[i + 1], miles: legMiles(l.distanceMeters ?? 0) }));
  return { ok: true, miles: sumMiles(out.map((l) => l.miles)), legs: out };
}
