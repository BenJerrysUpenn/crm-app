import { getProfile } from "@/lib/auth";
import { cleanRoute, routeEnds } from "@/lib/reimbursements/routeMiles";
import { computeRouteMiles } from "@/lib/reimbursements/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/reimbursements/route-miles   Body: { stops, start_at_store, end_at_store }
// Destinations mode's preview (bj-finance #210, rulings 14, 45): the miles
// from the store (unless start_at_store is false) through the stops and to
// the store (unless end_at_store is false), with each leg. Submitting
// computes them again; the browser's number is not used.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { stops?: unknown; start_at_store?: unknown; end_at_store?: unknown } | null;
  const ends = routeEnds(body);
  const stops = cleanRoute(body?.stops, ends);
  if (!stops.ok) return NextResponse.json({ error: stops.error }, { status: 400 });
  const route = await computeRouteMiles(stops.stops, ends);
  if (!route.ok) return NextResponse.json({ error: route.error }, { status: 400 });
  return NextResponse.json({ miles: route.miles, legs: route.legs });
}
