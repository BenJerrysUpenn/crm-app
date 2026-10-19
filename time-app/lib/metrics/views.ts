// Saved views (bj-finance #671): each manager keeps named pages of metric
// widgets ("my finance view", "my catering view") and switches between them.
// A view is a name, a position among the person's views, and an ordered list
// of widgets, each with its own settings (period, stream).
//
// Pure: no React, no Supabase. The API routes validate with it, the page's
// editor changes views with it, and both stores (the database, migration 39,
// and the browser, until that is applied) hold what it returns.

import { METRICS, METRIC_IDS, PERIODS, type MetricId, type Period, type WidgetConfig, type WidgetSettings } from "./widgets.ts";
import { STREAMS, type StreamFilter } from "./targets.ts";
import { savedRange } from "./weekRange.ts";

export const MAX_WIDGETS = 24;
export const MAX_NAME = 60;
export const MAX_VIEWS = 20;

export type View = { id: string; name: string; position: number; widgets: WidgetConfig[] };

type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/** A name with its spacing collapsed: how names are stored and compared. */
function tidy(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export function cleanName(raw: unknown): NameCheck {
  const name = typeof raw === "string" ? tidy(raw) : "";
  if (!name) return { ok: false, error: "Give the view a name." };
  if (name.length > MAX_NAME) return { ok: false, error: `Keep the name to ${MAX_NAME} characters.` };
  return { ok: true, name };
}

/** The other view already called `name` (case and spacing ignored), if any. */
function takenBy(views: View[], name: string, exceptId?: string): View | null {
  const key = tidy(name).toLowerCase();
  return views.find((v) => v.id !== exceptId && tidy(v.name).toLowerCase() === key) ?? null;
}

/**
 * `raw` as the name of one of `views` (the view `exceptId` when renaming it):
 * cleaned as cleanName does, and refused when another view already has it.
 */
export function checkName(views: View[], raw: unknown, exceptId?: string): NameCheck {
  const n = cleanName(raw);
  if (!n.ok) return n;
  const taken = takenBy(views, n.name, exceptId);
  return taken ? { ok: false, error: `You already have a view called "${taken.name}".` } : n;
}

function isMetric(x: unknown): x is MetricId {
  return typeof x === "string" && (METRIC_IDS as readonly string[]).includes(x);
}

function isStream(x: unknown): x is StreamFilter {
  return x === "all" || (typeof x === "string" && (STREAMS as readonly string[]).includes(x));
}

export function cleanSettings(metric: MetricId, raw: unknown): WidgetSettings {
  const def = METRICS[metric];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const period =
    typeof r.period === "string" && (PERIODS as readonly string[]).includes(r.period) && def.periods.includes(r.period as Period)
      ? (r.period as Period)
      : def.defaultPeriod;
  const out: WidgetSettings = { period };
  if (def.streams) out.stream = isStream(r.stream) ? r.stream : "all";
  if (def.weekRange) {
    // A view saved under the old month picker keeps its month, as that month's weeks.
    const range = savedRange(r.from, r.to, r.month);
    if (range) Object.assign(out, range);
  }
  return out;
}

let counter = 0;
/** A widget id: unique within a view; not a secret. */
export function newWidgetId(): string {
  counter = (counter + 1) % 1_000_000;
  return `w${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Whatever arrives (a request body, a stored row, the browser's copy) as a
 * clean widget list: unknown metrics dropped, settings fixed to what the
 * metric offers, ids unique, at most MAX_WIDGETS.
 */
export function cleanWidgets(raw: unknown): WidgetConfig[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WidgetConfig[] = [];
  for (const item of raw) {
    if (out.length >= MAX_WIDGETS) break;
    if (!item || typeof item !== "object") continue;
    const w = item as Record<string, unknown>;
    if (!isMetric(w.metric)) continue;
    let id = typeof w.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(w.id) ? w.id : newWidgetId();
    if (seen.has(id)) id = newWidgetId();
    seen.add(id);
    out.push({ id, metric: w.metric, settings: cleanSettings(w.metric, w.settings) });
  }
  return out;
}

function widget(metric: MetricId, settings: Partial<WidgetSettings> = {}): WidgetConfig {
  return { id: `${metric}-${settings.stream ?? "d"}`, metric, settings: cleanSettings(metric, settings) };
}

/** What a manager starts with: one finance page and one catering page. */
export const DEFAULT_VIEWS: Omit<View, "id">[] = [
  {
    name: "Finance",
    position: 0,
    // Live metrics first; the ones waiting on the finance feed after them.
    widgets: [
      widget("sales_vs_target"),
      widget("catering_ar"),
      widget("forward_cash"),
      widget("labour"),
      widget("weekly_ler"),
      widget("cash_on_hand"),
      widget("closed_month"),
    ],
  },
  {
    name: "Catering",
    position: 1,
    widgets: [
      widget("sales_vs_target", { stream: "catering", period: "12m" }),
      widget("catering_ar"),
      widget("leads"),
      widget("quote_to_booking"),
      widget("outreach"),
      widget("forward_cash"),
    ],
  },
];

// ---- edits (the page's editor) --------------------------------------------------

export function addWidget(view: View, metric: MetricId): View {
  if (view.widgets.length >= MAX_WIDGETS) return view;
  return { ...view, widgets: [...view.widgets, { id: newWidgetId(), metric, settings: cleanSettings(metric, {}) }] };
}

export function removeWidget(view: View, widgetId: string): View {
  return { ...view, widgets: view.widgets.filter((w) => w.id !== widgetId) };
}

/** Move a widget `delta` places (negative is up); clamps at the ends. */
export function moveWidget(view: View, widgetId: string, delta: number): View {
  const i = view.widgets.findIndex((w) => w.id === widgetId);
  if (i < 0) return view;
  const j = Math.max(0, Math.min(view.widgets.length - 1, i + delta));
  if (i === j) return view;
  const widgets = [...view.widgets];
  const [w] = widgets.splice(i, 1);
  widgets.splice(j, 0, w);
  return { ...view, widgets };
}

export function updateWidgetSettings(view: View, widgetId: string, settings: Partial<WidgetSettings>): View {
  return {
    ...view,
    widgets: view.widgets.map((w) => (w.id === widgetId ? { ...w, settings: cleanSettings(w.metric, { ...w.settings, ...settings }) } : w)),
  };
}

/** Views in display order. */
export function ordered(views: View[]): View[] {
  return [...views].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** Move a view one place left or right; returns every view with fresh positions. */
export function moveView(views: View[], viewId: string, delta: -1 | 1): View[] {
  const list = ordered(views);
  const i = list.findIndex((v) => v.id === viewId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list.map((v, k) => ({ ...v, position: k }));
  [list[i], list[j]] = [list[j], list[i]];
  return list.map((v, k) => ({ ...v, position: k }));
}

/** A free name based on `base`: "Finance copy", "Finance copy 2", ... */
export function freeName(views: View[], base: string): string {
  const stem = base.slice(0, MAX_NAME - 3);
  if (!takenBy(views, stem)) return stem;
  for (let n = 2; n < 100; n++) {
    const candidate = `${stem.slice(0, MAX_NAME - 3 - String(n).length)} ${n}`;
    if (!takenBy(views, candidate)) return candidate;
  }
  return `${stem.slice(0, 40)} ${Date.now().toString(36)}`;
}
