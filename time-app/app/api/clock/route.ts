import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { distanceMeters } from "@/lib/geo";
import { NextResponse } from "next/server";
import type { Location, TimeEntry } from "@/lib/types";

// POST { action: "in" | "out", lat, lng, accuracy }
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { action?: string; lat?: number; lng?: number; accuracy?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const { action, lat, lng, accuracy } = body;

  if (typeof lat !== "number" || typeof lng !== "number") {
    return NextResponse.json(
      { error: "Location required. Enable location access and try again." },
      { status: 400 },
    );
  }

  // Resolve the geofence: default location (admin client so it works regardless of RLS).
  const admin = createAdminClient();
  const { data: locs } = await admin
    .from("locations")
    .select("*")
    .order("is_default", { ascending: false })
    .order("id", { ascending: true })
    .limit(1);
  const loc = (locs?.[0] as Location) ?? null;

  let distance: number | null = null;
  if (loc) {
    distance = Math.round(distanceMeters(lat, lng, loc.latitude, loc.longitude));
    if (action === "in" && distance > loc.radius_meters) {
      return NextResponse.json(
        {
          error: `You're ${distance}m from ${loc.name}. You must be within ${loc.radius_meters}m to clock in.`,
          distance,
          radius: loc.radius_meters,
        },
        { status: 403 },
      );
    }
  }

  if (action === "in") {
    // Reject if already clocked in.
    const { data: openEntry } = await supabase
      .from("time_entries")
      .select("id")
      .eq("employee_id", user.id)
      .eq("status", "open")
      .maybeSingle();
    if (openEntry) {
      return NextResponse.json({ error: "Already clocked in." }, { status: 409 });
    }

    // Link to a shift starting within +/- 4h, if any.
    const now = Date.now();
    const { data: shifts } = await supabase
      .from("shifts")
      .select("id, starts_at")
      .eq("employee_id", user.id)
      .eq("published", true)
      .gte("starts_at", new Date(now - 4 * 3600000).toISOString())
      .lte("starts_at", new Date(now + 4 * 3600000).toISOString())
      .order("starts_at", { ascending: true })
      .limit(1);
    const shiftId = shifts?.[0]?.id ?? null;

    const { data, error } = await supabase
      .from("time_entries")
      .insert({
        employee_id: user.id,
        shift_id: shiftId,
        location_id: loc?.id ?? null,
        clock_in_lat: lat,
        clock_in_lng: lng,
        clock_in_accuracy_m: accuracy ?? null,
        clock_in_distance_m: distance,
        status: "open",
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ entry: data as TimeEntry });
  }

  if (action === "out") {
    const { data: openEntry } = await supabase
      .from("time_entries")
      .select("*")
      .eq("employee_id", user.id)
      .eq("status", "open")
      .maybeSingle();
    if (!openEntry) {
      return NextResponse.json({ error: "Not clocked in." }, { status: 409 });
    }
    const { data, error } = await supabase
      .from("time_entries")
      .update({
        clock_out_at: new Date().toISOString(),
        clock_out_lat: lat,
        clock_out_lng: lng,
        clock_out_distance_m: distance,
        status: "closed",
      })
      .eq("id", (openEntry as TimeEntry).id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ entry: data as TimeEntry });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
