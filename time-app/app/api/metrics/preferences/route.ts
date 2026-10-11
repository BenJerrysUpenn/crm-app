import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { isMissingTable } from "@/lib/storeHours";
import { NOT_ENABLED, isViewId } from "@/lib/metrics/viewsServer";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// PUT /api/metrics/preferences   Body: { active_view_id }
//
// Remembers which of their views the signed-in manager last had open, so the
// Metrics page opens on it next time (bj-finance #671). Migration 39's
// trigger refuses a view that is not theirs; RLS refuses anyone else's row.
export async function PUT(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed") return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as { active_view_id?: unknown } | null;
  const id = body?.active_view_id;
  if (!isViewId(id))
    return NextResponse.json({ error: "active_view_id must be one of your views." }, { status: 400 });

  const supabase = createClient();
  const own = await supabase.from("metric_views").select("id").eq("id", id).eq("owner_id", me.id).is("archived_at", null);
  if (own.error) {
    if (isMissingTable(own.error)) return NextResponse.json(NOT_ENABLED, { status: 503 });
    return NextResponse.json({ error: own.error.message }, { status: 500 });
  }
  if ((own.data ?? []).length === 0) return NextResponse.json({ error: "No such view." }, { status: 404 });

  const updated = await supabase
    .from("metric_preferences")
    .update({ active_view_id: Number(id) })
    .eq("owner_id", me.id)
    .select("owner_id");
  if (updated.error) {
    if (isMissingTable(updated.error)) return NextResponse.json(NOT_ENABLED, { status: 503 });
    return NextResponse.json({ error: updated.error.message }, { status: 500 });
  }
  if ((updated.data ?? []).length === 0) {
    const inserted = await supabase.from("metric_preferences").insert({ owner_id: me.id, active_view_id: Number(id) });
    if (inserted.error) return NextResponse.json({ error: inserted.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
