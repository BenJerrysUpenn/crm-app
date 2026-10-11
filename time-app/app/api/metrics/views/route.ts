import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { isMissingTable } from "@/lib/storeHours";
import { MAX_VIEWS, cleanName, cleanWidgets } from "@/lib/metrics/views";
import { NOT_ENABLED, VIEW_COLUMNS, rowToView } from "@/lib/metrics/viewsServer";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// force-dynamic does not stop Next caching a route handler's own fetches
// (see app/api/payroll/verify/route.ts); a stale read here would hide a view
// just saved.
export const fetchCache = "force-no-store";

/** Postgres: unique_violation (two live views with one name). */
const UNIQUE_VIOLATION = "23505";

// POST /api/metrics/views   Body: { name, widgets? }
//
// Saves a new Metrics view for the signed-in manager (bj-finance #671). It
// goes last among their views. Manager-only, here and in RLS (migration 39).
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed") return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as { name?: unknown; widgets?: unknown } | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  const name = cleanName(body.name);
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });

  const supabase = createClient();
  const existing = await supabase.from("metric_views").select("id, position").eq("owner_id", me.id).is("archived_at", null);
  if (existing.error) {
    if (isMissingTable(existing.error)) return NextResponse.json(NOT_ENABLED, { status: 503 });
    return NextResponse.json({ error: existing.error.message }, { status: 500 });
  }
  const rows = (existing.data ?? []) as { position: number }[];
  if (rows.length >= MAX_VIEWS)
    return NextResponse.json({ error: `You have ${MAX_VIEWS} views; delete one first.` }, { status: 409 });
  const position = rows.reduce((m, r) => Math.max(m, r.position + 1), 0);

  const { data, error } = await supabase
    .from("metric_views")
    .insert({ owner_id: me.id, name: name.name, position, widgets: cleanWidgets(body.widgets) })
    .select(VIEW_COLUMNS)
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION)
      return NextResponse.json({ error: `You already have a view called "${name.name}".` }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ view: rowToView(data) }, { status: 201 });
}
