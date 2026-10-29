// Mileage from destinations (bj-finance #210, rulings 2, 14, 45).
//
// The trip starts at the store unless the staff member turns "Start at the
// store" off (then it starts at the first stop: home -> Restaurant Depot ->
// store is entered as Restaurant Depot, then the store, and only that is
// paid), visits the stops in order, and ends at the store unless "End at the
// store" is off. With both off it is just the stops. Two points at least.
//
// Each leg is its own Google Routes API call (computeRoutes, DRIVE,
// TRAFFIC_AWARE), so Google picks the route a driver would take at that hour
// instead of the traffic-unaware one, which sent short city trips onto I-76
// and paid more miles than the Google Maps app shows. Each leg is rounded to
// 0.1 mi half-up (lib/reimbursements/money.ts) and the miles are their sum.
// This is the calculation Catering-Manager modules/maps.py uses for a
// catering quote's delivery miles: separate legs, traffic-aware, the way out
// departing 45 minutes before the event starts and the way back at its end.
//
// When each leg departs (legDepartures): a trip for a Catering Event with a
// start time leaves at the start minus OUTBOUND_LEAD_MINUTES, and its leg back
// to the store (on a trip that also left from the store) leaves at the
// event's end. Any other trip leaves at NO_TIME_DEPARTURE. The trip is always
// in the past, and the Routes API refuses a past departureTime for DRIVE, so
// those wall-clock times (New York) are put on the next date after today with
// the same weekday as the trip: same weekday, same hour, at most a week ahead.
//
// Server-only in practice: the key is GOOGLE_MAPS_API_KEY, read by the route
// that calls this, and never sent to a browser. Pure apart from the injected
// fetch and clock, so `node --test` drives it with stand-ins.

import { legMiles, sumMiles } from "./money.ts";
import { addDays, formatMinutes, nyWallClock, parseTime, weekdayOf } from "../coverage.ts";
import type { CateringEvent } from "./events.ts";

export const STORE_ADDRESS = "218 S 40th St, Philadelphia, PA 19104";
export const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
export const MAX_STOPS = 10;
/** A Catering Event trip leaves this long before the event starts (as Catering-Manager quotes it). */
export const OUTBOUND_LEAD_MINUTES = 45;
/** When a trip with no Catering Event start time leaves, New York wall clock. */
export const NO_TIME_DEPARTURE = "12:00";
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

/**
 * When the trip happened, as far as the app knows: the trip date, and the
 * Catering Event's date and times ("HH:MM", New York) when the Reason is one.
 */
export type TripTiming = {
  trip_date: string;
  event: Pick<CateringEvent, "date" | "start_time" | "end_time"> | null;
};

/**
 * A New York date plus minutes past its midnight (may be negative or past
 * 24:00) as an ISO instant. The offset is read at the guess and read again,
 * for a time near a DST change (as lib/payroll/verify.ts nyInputToIso does).
 */
export function nyInstant(date: string, minutes: number): string {
  const day = addDays(date, Math.floor(minutes / 1440));
  const asUtc = Date.parse(`${day}T${formatMinutes(((minutes % 1440) + 1440) % 1440)}:00Z`);
  const offsetAt = (ms: number) => {
    const wall = nyWallClock(new Date(ms).toISOString());
    return Date.parse(`${wall.date}T${formatMinutes(wall.minutes)}:00Z`) - ms;
  };
  let ms = asUtc - offsetAt(asUtc);
  ms = asUtc - offsetAt(ms);
  return new Date(ms).toISOString();
}

/** The first date after `today` that falls on the same weekday as `date`: 1 to 7 days ahead. */
export function nextSameWeekday(date: string, today: string): string {
  const ahead = ((weekdayOf(date) - weekdayOf(today) + 7) % 7) || 7;
  return addDays(today, ahead);
}

/**
 * Each leg's departureTime for the Routes API (see the header): the trip's
 * wall-clock times, on the next date after today with the trip's weekday. If
 * that would still not be in the future (an event starting just after
 * midnight), a week later.
 */
export function legDepartures(legCount: number, ends: RouteEnds, timing: TripTiming, now: Date): string[] {
  const start = timing.event ? parseTime(timing.event.start_time) : null;
  const ev = start != null ? timing.event! : null;
  const outbound = start != null ? start - OUTBOUND_LEAD_MINUTES : parseTime(NO_TIME_DEPARTURE)!;
  let back = outbound;
  if (start != null) {
    const end = parseTime(ev!.end_time);
    back = end == null ? start : end < start ? end + 1440 : end;
  }
  const returnLeg = ends.start_at_store && ends.end_at_store && legCount >= 2 ? legCount - 1 : -1;
  const minutes = Array.from({ length: legCount }, (_, i) => (i === returnLeg ? back : outbound));
  let day = nextSameWeekday(ev ? ev.date : timing.trip_date, nyWallClock(now.toISOString()).date);
  if (minutes.some((m) => Date.parse(nyInstant(day, m)) <= now.getTime())) day = addDays(day, 7);
  return minutes.map((m) => nyInstant(day, m));
}

export async function routeMiles(
  stops: string[],
  ends: RouteEnds,
  timing: TripTiming,
  opts: { apiKey: string | undefined; fetchImpl?: typeof fetch; now?: Date },
): Promise<RouteResult> {
  if (!opts.apiKey) return { ok: false, error: "Computing miles from destinations is not set up yet (no Maps key). Type the miles instead." };
  const points = routePoints(stops, ends);
  if (points.length < 2) return { ok: false, error: "A trip needs at least two points." };
  const departures = legDepartures(points.length - 1, ends, timing, opts.now ?? new Date());
  const doFetch = opts.fetchImpl ?? fetch;

  /** One leg's rounded miles, or what went wrong in words. A leg from a place to itself is 0 mi without asking Google. */
  async function leg(from: string, to: string, departureTime: string): Promise<{ ok: true; miles: number } | { ok: false; error: string }> {
    if (from === to) return { ok: true, miles: 0 };
    let payload: { routes?: { distanceMeters?: number }[] };
    try {
      const res = await doFetch(ROUTES_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": opts.apiKey!,
          "X-Goog-FieldMask": "routes.distanceMeters",
        },
        body: JSON.stringify({
          origin: { address: from },
          destination: { address: to },
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
          departureTime,
          computeAlternativeRoutes: false,
        }),
        cache: "no-store",
      });
      if (!res.ok) return { ok: false, error: `Google could not route that trip (HTTP ${res.status}). Check the addresses, or type the miles.` };
      payload = await res.json();
    } catch {
      return { ok: false, error: "Google Maps could not be reached. Try again, or type the miles." };
    }
    const route = payload.routes?.[0];
    if (!route) return { ok: false, error: "Google found no driving route through those stops. Check the addresses, or type the miles." };
    return { ok: true, miles: legMiles(route.distanceMeters ?? 0) };
  }

  const results = await Promise.all(points.slice(1).map((to, i) => leg(points[i], to, departures[i])));
  const failed = results.find((r) => !r.ok);
  if (failed && !failed.ok) return failed;
  const out = results.map((r, i) => ({ from: points[i], to: points[i + 1], miles: r.ok ? r.miles : 0 }));
  return { ok: true, miles: sumMiles(out.map((l) => l.miles)), legs: out };
}
