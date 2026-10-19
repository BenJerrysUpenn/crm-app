"use client";

// finance.withers-ventures.com/metrics (bj-finance #671): the manager's own
// saved views, each an ordered set of metric widgets with their own period
// and stream. Switch views with the tabs; "Customize" renames, reorders,
// duplicates or deletes the view and adds, moves or removes its widgets. A
// widget's period and stream can be changed at any time and are saved with
// the view.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MetricsData } from "@/lib/metrics/load";
import { METRICS, METRIC_IDS, PERIOD_LABEL, blurbFor, type MetricId, type WidgetConfig, type WidgetSettings } from "@/lib/metrics/widgets";
import { STREAM_LABEL, STREAMS, type StreamFilter } from "@/lib/metrics/targets";
import { pickRange, rangeLabel, shownRange, weekOptionLabel } from "@/lib/metrics/weekRange";
import {
  MAX_NAME, MAX_VIEWS, MAX_WIDGETS, addWidget, checkName, freeName, moveView, moveWidget, ordered, removeWidget,
  updateWidgetSettings, type View,
} from "@/lib/metrics/views";
import type { ViewsState } from "@/lib/metrics/viewsServer";
import { NotEnabled, applyPatch, localStore, readLocal, serverStore, writeLocal, type ViewPatch, type ViewStore } from "./viewStore";
import {
  ArWidget, ForwardWidget, LaborTargetWidget, LabourWidget, LeadsWidget, OutreachWidget, QuotesWidget, SalesWidget,
} from "./widgets";
import { CashWidget, ClosedMonthWidget, LerWidget } from "./feedWidgets";

const BTN =
  "inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-3 rounded-md text-sm border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500";
const BTN_DANGER =
  "inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-3 rounded-md text-sm border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 bg-white dark:bg-slate-900 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500";
const SELECT =
  "min-h-[44px] rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-100 px-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500";

export default function MetricsBoard({ data, initial, userId }: { data: MetricsData; initial: ViewsState; userId: string }) {
  const [mode, setMode] = useState<"server" | "local" | "readonly">(initial.mode === "server" ? "server" : initial.mode === "local" ? "local" : "readonly");
  const [views, setViews] = useState<View[]>(initial.mode === "server" ? initial.views : []);
  const [activeId, setActiveId] = useState<string | null>(initial.mode === "server" ? initial.activeId : null);
  const [ready, setReady] = useState(initial.mode === "server");
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const viewsRef = useRef(views);
  viewsRef.current = views;

  // Local (and read-only) mode starts from this browser's copy, or the defaults.
  useEffect(() => {
    if (initial.mode === "server") return;
    const local = readLocal(userId);
    setViews(local.views);
    setActiveId(local.activeId);
    setReady(true);
  }, [initial.mode, userId]);

  useEffect(() => {
    if (mode === "local" && ready) writeLocal(userId, views, activeId);
  }, [mode, ready, userId, views, activeId]);

  const store: ViewStore = useMemo(() => (mode === "server" ? serverStore : localStore(() => viewsRef.current)), [mode]);
  const list = useMemo(() => ordered(views), [views]);
  const active = list.find((v) => v.id === activeId) ?? list[0] ?? null;

  /** Move keyboard focus once React has drawn the change (an action must never drop focus to the page). */
  const pendingFocus = useRef<string | null>(null);
  const focusSoon = useCallback((id: string) => {
    pendingFocus.current = id;
  }, []);
  // After every render: if an action asked for focus somewhere, put it there.
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const el = document.getElementById(id) as HTMLElement | null;
    if (el && !(el as HTMLButtonElement).disabled) {
      el.focus();
      pendingFocus.current = null;
    }
  });

  const say = useCallback((msg: string) => {
    setError("");
    setStatus(msg);
  }, []);

  /** Run a store call; on "not enabled" move to this browser and keep going. */
  async function save<T>(run: (s: ViewStore) => Promise<T>): Promise<T | undefined> {
    try {
      return await run(store);
    } catch (e) {
      if (e instanceof NotEnabled) {
        setMode("local");
        const local = localStore(() => viewsRef.current);
        return await run(local);
      }
      setError((e as Error).message || "Could not save.");
      return undefined;
    }
  }

  async function patchView(view: View, patch: ViewPatch, message: string) {
    const before = views;
    setViews((vs) => vs.map((v) => (v.id === view.id ? applyPatch(v, patch) : v)));
    const out = await save((s) => s.patch(view.id, patch));
    if (out === undefined) setViews(before);
    else say(message);
  }

  function changeWidgets(next: View, message: string) {
    if (!active) return;
    void patchView(active, { widgets: next.widgets }, message);
  }

  async function switchTo(id: string) {
    setActiveId(id);
    const v = list.find((x) => x.id === id);
    say(v ? `Showing ${v.name}.` : "");
    await save((s) => s.setActive(id));
  }

  async function createView(name: string, widgets: WidgetConfig[]) {
    if (list.length >= MAX_VIEWS) {
      setError(`You have ${MAX_VIEWS} views; delete one first.`);
      return undefined;
    }
    const view = await save((s) => s.create(name, widgets));
    if (!view) return;
    setViews((vs) => [...vs, view]);
    setActiveId(view.id);
    focusSoon(`view-tab-${view.id}`);
    await save((s) => s.setActive(view.id));
    say(`Saved new view ${view.name}.`);
    return view;
  }

  async function archiveActive() {
    if (!active) return;
    if (list.length <= 1) return setError("Keep at least one view.");
    const rest = list.filter((v) => v.id !== active.id);
    const before = views;
    setViews(rest);
    setActiveId(rest[0].id);
    const out = await save((s) => s.patch(active.id, { archived: true }));
    if (out === undefined) {
      setViews(before);
      setActiveId(active.id);
      return;
    }
    focusSoon(`view-tab-${rest[0].id}`);
    await save((s) => s.setActive(rest[0].id));
    say(`Deleted view ${active.name}.`);
  }

  async function shiftView(delta: -1 | 1) {
    if (!active) return;
    const next = moveView(list, active.id, delta);
    const changed = next.filter((v) => list.find((o) => o.id === v.id)?.position !== v.position);
    if (changed.length === 0) return;
    const before = views;
    setViews(next);
    for (const v of changed) {
      const out = await save((s) => s.patch(v.id, { position: v.position }));
      if (out === undefined) return setViews(before);
    }
    say(`Moved ${active.name} ${delta < 0 ? "left" : "right"}.`);
  }

  if (!ready) return <p className="text-sm text-slate-600 dark:text-slate-400">Loading your views…</p>;

  return (
    <div className="metrics-root space-y-4">
      {mode === "local" && (
        <p className="text-xs rounded-md bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 px-3 py-2">
          Your views are saved in this browser only for now. Once saved views are switched on, they follow you to any device.
        </p>
      )}
      {initial.mode === "error" && (
        <p role="alert" className="text-xs rounded-md bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 px-3 py-2">
          Could not load your saved views ({initial.message}). Showing this browser&rsquo;s copy; changes are kept here.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ViewTabs list={list} activeId={active?.id ?? null} onSwitch={switchTo} />
        <button type="button" className={BTN} aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
          {editing ? "Done" : "Customize"}
        </button>
        <NewViewButton list={list} onCreate={(name) => createView(name, [])} />
        <p className="sr-only" role="status" aria-live="polite">{status}</p>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
      </div>

      {editing && active && (
        <ViewEditor
          key={active.id}
          view={active}
          list={list}
          onRename={(name) => patchView(active, { name }, `Renamed to ${name}.`)}
          onMove={shiftView}
          onDuplicate={() => createView(freeName(list, `${active.name} copy`), active.widgets)}
          onDelete={archiveActive}
          onAdd={(metric) => changeWidgets(addWidget(active, metric), `Added ${METRICS[metric].title}.`)}
        />
      )}

      {active && active.widgets.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center">
          <p className="text-sm text-slate-700 dark:text-slate-300">This view has no metrics yet.</p>
          {!editing && (
            <button type="button" className={`${BTN} mt-3`} onClick={() => setEditing(true)}>
              Add metrics
            </button>
          )}
        </div>
      )}

      {active?.widgets.map((w, i) => (
        <WidgetCard
          key={w.id}
          widget={w}
          data={data}
          editing={editing}
          first={i === 0}
          last={i === active.widgets.length - 1}
          onSettings={(s) =>
            changeWidgets(
              updateWidgetSettings(active, w.id, s),
              `${METRICS[w.metric].title}: ${settingsNote(w, s, data)}.`,
            )
          }
          onMove={(d) => {
            const atEnd = d < 0 ? i + d <= 0 : i + d >= active.widgets.length - 1;
            changeWidgets(moveWidget(active, w.id, d), `Moved ${METRICS[w.metric].title} ${d < 0 ? "up" : "down"}.`);
            // Keep focus on the arrow pressed, or on the other one once this end is reached.
            focusSoon(`${atEnd ? (d < 0 ? "down" : "up") : d < 0 ? "up" : "down"}-${w.id}`);
          }}
          onRemove={() => {
            const next = active.widgets[i + 1] ?? active.widgets[i - 1];
            changeWidgets(removeWidget(active, w.id), `Removed ${METRICS[w.metric].title}.`);
            focusSoon(next ? `h-${next.id}` : "add-metric");
          }}
        />
      ))}

      {data.problems.length > 0 && (
        <details className="text-xs text-slate-600 dark:text-slate-400">
          <summary className="cursor-pointer min-h-[44px] inline-flex items-center">
            Some numbers could not be loaded; reload the page to try again. Technical detail ({data.problems.length})
          </summary>
          <ul className="list-disc pl-5 mt-1">
            {data.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ViewTabs({ list, activeId, onSwitch }: { list: View[]; activeId: string | null; onSwitch: (id: string) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKey(e: React.KeyboardEvent, i: number) {
    let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % list.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = list.length - 1;
    if (j < 0) return;
    e.preventDefault();
    refs.current[j]?.focus();
    onSwitch(list[j].id);
  }
  return (
    <div role="tablist" aria-label="Your saved views" className="flex gap-1 overflow-x-auto max-w-full pb-1 -mx-1 px-1">
      {list.map((v, i) => {
        const selected = v.id === activeId;
        return (
          <button
            key={v.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`view-tab-${v.id}`}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSwitch(v.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`shrink-0 min-h-[44px] px-4 rounded-full text-sm border whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
              selected
                ? "bg-emerald-600 border-emerald-600 text-white font-medium"
                : "bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
            }`}
          >
            {v.name}
          </button>
        );
      })}
    </div>
  );
}

function NewViewButton({ list, onCreate }: { list: View[]; onCreate: (name: string) => Promise<View | undefined> }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const [returnFocus, setReturnFocus] = useState(false);
  useEffect(() => {
    if (!open && returnFocus) {
      opener.current?.focus();
      setReturnFocus(false);
    }
  }, [open, returnFocus]);
  const cancel = () => {
    setOpen(false);
    setReturnFocus(true);
  };
  const [name, setName] = useState("");
  const [problem, setProblem] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  if (!open)
    return (
      <button
        ref={opener}
        type="button"
        className={BTN}
        onClick={() => {
          setName("");
          setProblem("");
          setOpen(true);
        }}
      >
        New view
      </button>
    );
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = checkName(list, name);
    if (!n.ok) return setProblem(n.error);
    const made = await onCreate(n.name);
    if (made) setOpen(false);
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2" aria-label="New view">
      <label className="sr-only" htmlFor="new-view-name">
        New view name
      </label>
      <input
        id="new-view-name"
        ref={input}
        value={name}
        maxLength={MAX_NAME}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && cancel()}
        placeholder={freeName(list, "e.g. My catering view")}
        className="min-h-[44px] w-56 max-w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        aria-invalid={Boolean(problem)}
        aria-describedby={problem ? "new-view-problem" : undefined}
      />
      <button type="submit" className={BTN}>
        Create
      </button>
      <button type="button" className={BTN} onClick={cancel}>
        Cancel
      </button>
      {problem && (
        <span id="new-view-problem" role="alert" className="text-sm text-red-700 dark:text-red-300">
          {problem}
        </span>
      )}
    </form>
  );
}

function ViewEditor({
  view, list, onRename, onMove, onDuplicate, onDelete, onAdd,
}: {
  view: View;
  list: View[];
  onRename: (name: string) => void;
  onMove: (d: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAdd: (metric: MetricId) => void;
}) {
  const [name, setName] = useState(view.name);
  const [problem, setProblem] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [metric, setMetric] = useState<MetricId>("sales_vs_target");
  const index = list.findIndex((v) => v.id === view.id);

  function rename(e: React.FormEvent) {
    e.preventDefault();
    const n = checkName(list, name, view.id);
    if (!n.ok) return setProblem(n.error);
    setProblem("");
    if (n.name !== view.name) onRename(n.name);
  }

  return (
    <section aria-label={`Customize ${view.name}`} className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
      <form onSubmit={rename} className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col">
          <label htmlFor="view-name" className="text-xs text-slate-600 dark:text-slate-400 mb-1">
            View name
          </label>
          <input
            id="view-name"
            value={name}
            maxLength={MAX_NAME}
            onChange={(e) => setName(e.target.value)}
            className="min-h-[44px] w-64 max-w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-invalid={Boolean(problem)}
          />
        </div>
        <button type="submit" className={BTN}>
          Rename
        </button>
        {problem && (
          <span role="alert" className="text-sm text-red-700 dark:text-red-300">
            {problem}
          </span>
        )}
      </form>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} onClick={() => onMove(-1)} disabled={index <= 0}>
          Move view left
        </button>
        <button type="button" className={BTN} onClick={() => onMove(1)} disabled={index >= list.length - 1}>
          Move view right
        </button>
        <button type="button" className={BTN} onClick={onDuplicate} disabled={list.length >= MAX_VIEWS}>
          Duplicate view
        </button>
        {!confirming ? (
          <>
            <button type="button" className={BTN_DANGER} onClick={() => setConfirming(true)} disabled={list.length <= 1} aria-describedby={list.length <= 1 ? "keep-one" : undefined}>
              Delete view
            </button>
            {list.length <= 1 && (
              <span id="keep-one" className="text-xs text-slate-600 dark:text-slate-400">
                Keep at least one view.
              </span>
            )}
          </>
        ) : (
          <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm delete">
            <span className="text-sm text-slate-700 dark:text-slate-200">Delete {view.name}?</span>
            <button
              type="button"
              className="inline-flex items-center justify-center min-h-[44px] px-3 rounded-md text-sm font-medium bg-red-700 hover:bg-red-800 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              onClick={onDelete}
            >
              Yes, delete
            </button>
            <button type="button" className={BTN} onClick={() => setConfirming(false)} autoFocus>
              Keep it
            </button>
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col min-w-0">
          <label htmlFor="add-metric" className="text-xs text-slate-600 dark:text-slate-400 mb-1">
            Add a metric
          </label>
          <select id="add-metric" className={`${SELECT} max-w-full`} value={metric} onChange={(e) => setMetric(e.target.value as MetricId)}>
            {METRIC_IDS.map((id) => (
              <option key={id} value={id}>
                {METRICS[id].title}
                {view.widgets.some((w) => w.metric === id) ? " (on this view)" : ""}
                {METRICS[id].source === "feed" ? " (waiting on feed)" : ""}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className={BTN} onClick={() => onAdd(metric)} disabled={view.widgets.length >= MAX_WIDGETS}>
          Add
        </button>
      </div>
    </section>
  );
}

/** What a settings change says in the status line: the new range, or the new period. */
function settingsNote(w: WidgetConfig, s: Partial<WidgetSettings>, data: MetricsData): string {
  if (METRICS[w.metric].weekRange && data.laborTarget && ("from" in s || "to" in s)) {
    const lt = data.laborTarget;
    return `weeks of ${rangeLabel(shownRange(s, lt.weeks.map((x) => x.start), lt.defaultRange))}`;
  }
  return PERIOD_LABEL[s.period ?? w.settings.period];
}

/** A first and a last week, each named by its Sunday: the card covers every week from one to the other. */
function WeekRangePicker({
  widget, title, data, onSettings,
}: {
  widget: WidgetConfig;
  title: string;
  data: NonNullable<MetricsData["laborTarget"]>;
  onSettings: (s: Partial<WidgetSettings>) => void;
}) {
  const starts = data.weeks.map((w) => w.start);
  const range = shownRange(widget.settings, starts, data.defaultRange);
  const pick = (end: "from" | "to", week: string) => onSettings(pickRange(range, end, week, data.defaultRange));
  const options = starts.map((d) => (
    <option key={d} value={d}>
      {weekOptionLabel(d, starts)}
    </option>
  ));
  return (
    <span className="flex items-center gap-2" role="group" aria-label={`Weeks for ${title}`}>
      <label className="sr-only" htmlFor={`from-${widget.id}`}>
        First week (by its Sunday) for {title}
      </label>
      <select id={`from-${widget.id}`} className={SELECT} value={range.from} onChange={(e) => pick("from", e.target.value)}>
        {options}
      </select>
      <span aria-hidden="true" className="text-sm text-slate-600 dark:text-slate-400">
        to
      </span>
      <label className="sr-only" htmlFor={`to-${widget.id}`}>
        Last week (by its Sunday) for {title}
      </label>
      <select id={`to-${widget.id}`} className={SELECT} value={range.to} onChange={(e) => pick("to", e.target.value)}>
        {options}
      </select>
    </span>
  );
}

function WidgetCard({
  widget, data, editing, first, last, onSettings, onMove, onRemove,
}: {
  widget: WidgetConfig;
  data: MetricsData;
  editing: boolean;
  first: boolean;
  last: boolean;
  onSettings: (s: Partial<WidgetSettings>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  const def = METRICS[widget.metric];
  const headingId = `h-${widget.id}`;
  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 min-w-0">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2 mb-3">
        <div className="flex-1 min-w-[12rem]">
          <h2 id={headingId} tabIndex={-1} className="text-base font-semibold text-slate-900 dark:text-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded">
            {def.title}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">{blurbFor(def, widget.settings.period)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {def.periods.length > 1 && (
            <>
              <label className="sr-only" htmlFor={`period-${widget.id}`}>
                Period for {def.title}
              </label>
              <select id={`period-${widget.id}`} className={SELECT} value={widget.settings.period} onChange={(e) => onSettings({ period: e.target.value as WidgetSettings["period"] })}>
                {def.periods.map((p) => (
                  <option key={p} value={p}>
                    {PERIOD_LABEL[p]}
                  </option>
                ))}
              </select>
            </>
          )}
          {def.weekRange && data.laborTarget && <WeekRangePicker widget={widget} title={def.title} data={data.laborTarget} onSettings={onSettings} />}
          {def.streams && (
            <>
              <label className="sr-only" htmlFor={`stream-${widget.id}`}>
                Stream for {def.title}
              </label>
              <select id={`stream-${widget.id}`} className={SELECT} value={widget.settings.stream ?? "all"} onChange={(e) => onSettings({ stream: e.target.value as StreamFilter })}>
                {(["all", ...STREAMS] as StreamFilter[]).map((s) => (
                  <option key={s} value={s}>
                    {STREAM_LABEL[s]}
                  </option>
                ))}
              </select>
            </>
          )}
          {editing && (
            <span className="flex gap-1" role="group" aria-label={`Arrange ${def.title}`}>
              <button id={`up-${widget.id}`} type="button" className={BTN} onClick={() => onMove(-1)} disabled={first} aria-label={`Move ${def.title} up`}>
                ↑
              </button>
              <button id={`down-${widget.id}`} type="button" className={BTN} onClick={() => onMove(1)} disabled={last} aria-label={`Move ${def.title} down`}>
                ↓
              </button>
              <button type="button" className={BTN} onClick={onRemove} aria-label={`Remove ${def.title} from this view`}>
                Remove
              </button>
            </span>
          )}
        </div>
      </header>
      <WidgetBody widget={widget} data={data} />
    </section>
  );
}

function WidgetBody({ widget, data }: { widget: WidgetConfig; data: MetricsData }) {
  const s = widget.settings;
  switch (widget.metric) {
    case "sales_vs_target":
      return <SalesWidget data={data} settings={s} />;
    case "cash_on_hand":
      return <CashWidget data={data} settings={s} />;
    case "catering_ar":
      return <ArWidget data={data} />;
    case "weekly_ler":
      return <LerWidget data={data} settings={s} />;
    case "forward_cash":
      return <ForwardWidget data={data} />;
    case "labour":
      return <LabourWidget data={data} settings={s} />;
    case "labor_vs_target":
      return <LaborTargetWidget data={data} settings={s} />;
    case "closed_month":
      return <ClosedMonthWidget data={data} settings={s} />;
    case "leads":
      return <LeadsWidget data={data} settings={s} />;
    case "outreach":
      return <OutreachWidget data={data} settings={s} />;
    case "quote_to_booking":
      return <QuotesWidget data={data} settings={s} />;
  }
}
