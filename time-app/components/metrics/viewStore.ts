// Where a manager's Metrics views are kept (bj-finance #671).
//
//   server  public.metric_views and metric_preferences (migration 39), through
//           /api/metrics/views and /api/metrics/preferences.
//   local   this browser's localStorage, until migration 39 is applied. The
//           page says so. Views kept here do not follow the manager to
//           another device.
//
// Both answer the same calls, so the page does not care which it has. A
// server call that comes back "views_not_enabled" (503) throws NotEnabled
// and the page moves to the local store.

import { DEFAULT_VIEWS, cleanWidgets, ordered, type View } from "@/lib/metrics/views";
import type { WidgetConfig } from "@/lib/metrics/widgets";

export class NotEnabled extends Error {}

export type ViewPatch = { name?: string; widgets?: WidgetConfig[]; position?: number; archived?: true };

/** A view with a patch's name, widgets and position applied; archiving is the caller's to handle. */
export function applyPatch(view: View, patch: ViewPatch): View {
  return {
    ...view,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.widgets && { widgets: patch.widgets }),
    ...(patch.position !== undefined && { position: patch.position }),
  };
}

export interface ViewStore {
  readonly kind: "server" | "local";
  create(name: string, widgets: WidgetConfig[]): Promise<View>;
  patch(id: string, patch: ViewPatch): Promise<View | null>;
  setActive(id: string): Promise<void>;
}

async function call(method: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 503 && json.code === "views_not_enabled") throw new NotEnabled(String(json.error ?? ""));
  if (!res.ok) throw new Error(String(json.error ?? `Saving failed (${res.status}).`));
  return json;
}

export const serverStore: ViewStore = {
  kind: "server",
  async create(name, widgets) {
    return (await call("POST", "/api/metrics/views", { name, widgets })).view as View;
  },
  async patch(id, patch) {
    const out = await call("PATCH", `/api/metrics/views/${encodeURIComponent(id)}`, patch);
    return patch.archived ? null : (out.view as View);
  },
  async setActive(id) {
    await call("PUT", "/api/metrics/preferences", { active_view_id: id });
  },
};

type Saved = { views: View[]; activeId: string | null };

function storageKey(userId: string) {
  return `withers-metrics-views:v1:${userId}`;
}

export function readLocal(userId: string): { views: View[]; activeId: string | null } {
  let saved: Saved | null = null;
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    saved = raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    saved = null;
  }
  if (!saved || !Array.isArray(saved.views) || saved.views.length === 0) {
    const views = DEFAULT_VIEWS.map((v, i) => ({ ...v, id: `local-${i + 1}` }));
    return { views, activeId: views[0].id };
  }
  const views = ordered(
    saved.views
      .filter((v) => v && typeof v.id === "string" && typeof v.name === "string")
      .map((v) => ({ id: v.id, name: v.name, position: Number(v.position) || 0, widgets: cleanWidgets(v.widgets) })),
  );
  return { views, activeId: views.some((v) => v.id === saved!.activeId) ? saved.activeId : (views[0]?.id ?? null) };
}

/** Saves the page's views in this browser (called by the page after every change in local mode). */
export function writeLocal(userId: string, views: View[], activeId: string | null): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify({ views, activeId }));
  } catch {
    // Private windows and full storage: the change holds for this visit only.
  }
}

/**
 * A store over this browser's localStorage. It only answers each call; the
 * page writes its whole state with writeLocal after every change, so the
 * browser's copy is always what is on screen.
 */
export function localStore(snapshot: () => View[]): ViewStore {
  return {
    kind: "local",
    async create(name, widgets) {
      const views = snapshot();
      const id = `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      return { id, name, position: views.reduce((m, v) => Math.max(m, v.position + 1), 0), widgets: cleanWidgets(widgets) };
    },
    async patch(id, patch) {
      if (patch.archived) return null;
      const v = snapshot().find((x) => x.id === id);
      if (!v) return null;
      return applyPatch(v, patch.widgets ? { ...patch, widgets: cleanWidgets(patch.widgets) } : patch);
    },
    async setActive() {},
  };
}
