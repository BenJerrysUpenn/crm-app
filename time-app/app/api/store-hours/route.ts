import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { dayKey } from "@/lib/format";
import { addMonths, isISODate } from "@/lib/holidays";
import { isMissingTable, parseWeek } from "@/lib/storeHours";
import type { StoreHours, StoreHoursException } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// force-dynamic alone does not stop Next caching the fetches this route makes
// (see lib/supabase/admin.ts); this does. Both are here on purpose — hours the
// manager just saved must not read back stale.
export const fetchCache = "force-no-store";

function today(): string {
  return dayKey(new Date().toISOString());
}

// GET /api/store-hours
//   ?from=YYYY-MM-DD  first date of the exception window (default: today)
//   ?to=YYYY-MM-DD    last date of it (default: from + 12 months)
// -> { hours: StoreHours[], exceptions: StoreHoursException[], migrationNeeded }
// Any signed-in user may read; RLS allows select to all authenticated.
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const url = new URL(request.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  if (fromParam && !isISODate(fromParam))
    return NextResponse.json({ error: "from must be a date like 2026-09-20." }, { status: 400 });
  if (toParam && !isISODate(toParam))
    return NextResponse.json({ error: "to must be a date like 2026-09-20." }, { status: 400 });
  const from = fromParam ?? today();
  const to = toParam ?? addMonths(from, 12);
  if (to < from)
    return NextResponse.json({ error: "to must not be before from." }, { status: 400 });

  const supabase = createClient();
  const hoursRes = await supabase.from("store_hours").select("*").order("weekday");
  const excRes = await supabase
    .from("store_hours_exceptions")
    .select("*")
    .gte("date", from)
    .lte("date", to)
    .order("date");

  // Before migration 24 the tables simply aren't there. That is a normal
  // "not set up yet" state, not a server error.
  if (isMissingTable(hoursRes.error) || isMissingTable(excRes.error))
    return NextResponse.json({ hours: [], exceptions: [], migrationNeeded: true });
  if (hoursRes.error) return NextResponse.json({ error: hoursRes.error.message }, { status: 400 });
  if (excRes.error) return NextResponse.json({ error: excRes.error.message }, { status: 400 });

  return NextResponse.json({
    hours: (hoursRes.data as StoreHours[]) ?? [],
    exceptions: (excRes.data as StoreHoursException[]) ?? [],
    migrationNeeded: false,
  });
}

// PUT /api/store-hours
// Body: { days: [{ weekday, is_closed, opens, closes }, ... x7] }
// Replaces the whole weekly pattern in one save. -> { hours: StoreHours[] }
export async function PUT(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object")
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });

  const parsed = parseWeek((body as { days?: unknown }).days);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const now = new Date().toISOString();
  const rows = parsed.value.map((d) => ({
    weekday: d.weekday,
    is_closed: d.is_closed,
    opens: d.opens,
    closes: d.closes,
    updated_at: now,
  }));

  const supabase = createClient();
  const { data, error } = await supabase
    .from("store_hours")
    .upsert(rows, { onConflict: "weekday" })
    .select();
  if (isMissingTable(error))
    return NextResponse.json(
      { error: "Store hours table is missing. Run migration 24 in Supabase first." },
      { status: 503 },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ hours: (data as StoreHours[]) ?? [] });
}
