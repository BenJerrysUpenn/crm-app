// Saved views in the database (migration 39), for the Metrics page and its
// API routes (bj-finance #671). Reads and writes run as the signed-in
// manager through the SSR client: RLS lets a manager touch only their own
// rows. Before migration 39 is applied every call reports "not enabled" and
// the page keeps views in the browser instead.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingTable } from "@/lib/storeHours";
import { DEFAULT_VIEWS, cleanWidgets, ordered, type View } from "./views.ts";

export type ViewsState =
  | { mode: "server"; views: View[]; activeId: string | null }
  | { mode: "local" }
  | { mode: "error"; message: string };

type Row = { id: number; name: string; position: number; widgets: unknown };

/** What the API answers (503) before migration 39 is applied. */
export const NOT_ENABLED = {
  error: "Saved views are not switched on yet (migration 39). Your views are kept in this browser.",
  code: "views_not_enabled",
};

export const VIEW_COLUMNS = "id, name, position, widgets";

export function rowToView(r: Row): View {
  return { id: String(r.id), name: r.name, position: r.position, widgets: cleanWidgets(r.widgets) };
}

/**
 * The manager's live views and the one they last had open. A manager with no
 * views is given the two defaults (Finance, Catering), saved as theirs.
 */
export async function loadViews(supabase: SupabaseClient, ownerId: string): Promise<ViewsState> {
  const read = () =>
    supabase.from("metric_views").select(VIEW_COLUMNS).eq("owner_id", ownerId).is("archived_at", null).order("position");
  let { data, error } = await read();
  if (error) return isMissingTable(error) ? { mode: "local" } : { mode: "error", message: error.message };
  if ((data ?? []).length === 0) {
    const seed = DEFAULT_VIEWS.map((v) => ({ owner_id: ownerId, name: v.name, position: v.position, widgets: v.widgets }));
    const inserted = await supabase.from("metric_views").insert(seed).select(VIEW_COLUMNS);
    // A second tab seeding at the same moment trips the unique name index; read what it wrote.
    ({ data, error } = inserted.error ? await read() : inserted);
    if (error) return { mode: "error", message: error.message };
  }
  const views = ordered(((data ?? []) as Row[]).map(rowToView));
  const pref = await supabase.from("metric_preferences").select("active_view_id").eq("owner_id", ownerId).maybeSingle();
  const wanted = pref.data?.active_view_id != null ? String(pref.data.active_view_id) : null;
  const activeId = views.some((v) => v.id === wanted) ? wanted : (views[0]?.id ?? null);
  return { mode: "server", views, activeId };
}
