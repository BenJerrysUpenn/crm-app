"use client";

// One chart on the Metrics page (bj-finance #671), drawn with Chart.js.
//
// WHY CHART.JS. The time app had no chart library. Chart.js is small (one
// dependency, and only the bar and line pieces are registered here), mature,
// draws on canvas so a 13-week chart stays smooth on a phone, and has hover
// and touch tooltips built in. A canvas is not readable by a screen reader or
// a keyboard on its own, so this wrapper adds what it lacks: an HTML legend,
// a "Show numbers" table of every value, and arrow-key stepping through the
// points (the tooltip follows) when the chart has focus.
//
// Colours come from CSS custom properties on .metrics-root (globals.css), one
// set for light and one for dark, validated for colour-blind separation; the
// chart re-reads them when the theme changes.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Chart as ChartType, ChartConfiguration } from "chart.js";

export type SeriesColor = "in_store" | "catering" | "concessions" | "orange" | "target" | "serious" | "other";
export type ValueFormat = "money" | "count" | "hours" | "ratio" | "pct";

export type Series = {
  label: string;
  values: (number | null)[];
  color: SeriesColor;
  type?: "bar" | "line";
  dashed?: boolean;
  /** A line filled down to the series below it (or the axis): for running totals. */
  area?: boolean;
  /** Bars (or areas) with the same stack id stack. */
  stack?: string;
  /** Bars at these indexes drawn in another colour, with their own legend entry: weeks over target. */
  highlight?: { indexes: number[]; color: SeriesColor; label: string };
};

/** "#rrggbb" at an opacity, for area fills (canvas has no color-mix everywhere). */
function alpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const VAR: Record<SeriesColor, string> = {
  in_store: "--m-series-1",
  orange: "--m-series-2",
  catering: "--m-series-3",
  concessions: "--m-series-4",
  target: "--m-target",
  serious: "--m-serious",
  other: "--m-other",
};

/** ", over target" after a highlighted bar's value, so the tooltip says it in words as well as colour. */
function highlightNote(s: Series | undefined, index: number): string {
  return s?.highlight?.indexes.includes(index) ? `, ${s.highlight.label.toLowerCase()}` : "";
}

export function formatValue(v: number | null | undefined, format: ValueFormat, compact = false): string {
  if (v == null || Number.isNaN(v)) return "–";
  switch (format) {
    case "money": {
      const abs = Math.abs(v);
      const sign = v < 0 ? "-" : "";
      if (compact && abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1).replace(/\.0$/, "")}K`;
      if (compact) return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
      return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
    }
    case "count":
      return Math.round(v).toLocaleString("en-US");
    case "hours":
      return `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })} h`;
    case "ratio":
      return v.toFixed(2);
    case "pct":
      return `${(v * 100).toFixed(1)}%`;
  }
}

function readVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || "#64748b";
}

let registered: Promise<typeof import("chart.js")> | null = null;
function chartJs() {
  registered ??= import("chart.js").then((m) => {
    m.Chart.register(m.BarController, m.LineController, m.BarElement, m.LineElement, m.PointElement, m.CategoryScale, m.LinearScale, m.Tooltip, m.Filler);
    return m;
  });
  return registered;
}

export default function Chart({
  labels,
  series,
  format,
  title,
  stacked = false,
  height = 240,
  beginAtZero = true,
  tableLabel = "Period",
  heading,
  emptyText,
  horizontal = false,
  dim,
  tickChars = 24,
  gaps,
  table,
}: {
  labels: string[];
  series: Series[];
  format: ValueFormat;
  /** What the chart shows, for screen readers and the table caption. */
  title: string;
  stacked?: boolean;
  height?: number;
  beginAtZero?: boolean;
  tableLabel?: string;
  /** A short visible title above the chart (for a card holding more than one chart). */
  heading?: string;
  /** Shown instead of the chart when every value is zero or missing. */
  emptyText?: string;
  /** Bars run left to right, one row per label (long labels such as customers). */
  horizontal?: boolean;
  /** Indexes drawn lighter: a week still in progress, months still to come. */
  dim?: number[];
  /** Longest category label drawn on the axis; the table always has the full text. */
  tickChars?: number;
  /** Indexes with no value, marked "n/a" on the axis (a missing week, never a zero bar). */
  gaps?: number[];
  /** A table of the card's own to show behind "Show numbers" instead of the generated one. */
  table?: ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ChartType | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const hintId = useId();

  const [theme, setTheme] = useState(0);
  const signature = useMemo(
    () => JSON.stringify({ labels, series, format, stacked, beginAtZero, horizontal, dim, tickChars, gaps }),
    [labels, series, format, stacked, beginAtZero, horizontal, dim, tickChars, gaps],
  );
  const empty = series.every((s) => s.type === "line" || s.values.every((v) => v == null || v === 0));

  // Light and dark are different colours, read from CSS: redraw the chart when the theme changes.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme((t) => t + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = await chartJs();
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const root = canvas.closest(".metrics-root") ?? document.documentElement;
      const colours = () => ({
        text: readVar(root, "--m-text"),
        muted: readVar(root, "--m-muted"),
        grid: readVar(root, "--m-grid"),
        surface: readVar(root, "--m-surface"),
        series: series.map((s) => readVar(root, VAR[s.color])),
      });
      const c = colours();
      const dimmed = new Set(dim ?? []);
      const fillFor = (colour: string, s: Series) => {
        const lit = new Set(s.highlight?.indexes ?? []);
        const other = s.highlight ? readVar(root, VAR[s.highlight.color]) : colour;
        return (ctx: { dataIndex: number }) => {
          const base = lit.has(ctx.dataIndex) ? other : colour;
          return dimmed.has(ctx.dataIndex) ? alpha(base, 0.45) : base;
        };
      };
      const valueAxis = horizontal ? "x" : "y";
      const categoryAxis = horizontal ? "y" : "x";
      // Narrow screens get shorter axis labels, so the bars keep their room.
      const maxChars = (canvas.parentElement?.clientWidth ?? 800) < 520 ? Math.min(tickChars, 18) : tickChars;
      const short = (label: unknown) => {
        const t = String(label ?? "");
        return t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t;
      };
      const config: ChartConfiguration = {
        type: "bar",
        data: {
          labels,
          datasets: series.map((s, i) => {
            const line = s.type === "line" || s.area;
            const firstArea = s.area && series.findIndex((x) => x.area && (x.stack ?? "all") === (s.stack ?? "all")) === i;
            return {
              type: line ? "line" : "bar",
              label: s.label,
              data: s.values,
              backgroundColor: s.area ? alpha(c.series[i], 0.35) : line ? "transparent" : fillFor(c.series[i], s),
              fill: s.area ? (firstArea ? "origin" : "-1") : false,
              borderColor: line ? c.series[i] : c.surface,
              borderWidth: line ? 2 : stacked ? (horizontal ? { right: 2 } : { top: 2 }) : 0,
              borderDash: s.dashed ? [6, 4] : undefined,
              borderRadius: line ? 0 : 4,
              borderSkipped: horizontal ? "start" : "bottom",
              pointRadius: line ? (labels.length > 20 || s.area ? 0 : 3) : 0,
              pointHoverRadius: 5,
              pointBackgroundColor: c.series[i],
              pointBorderColor: c.series[i],
              spanGaps: false,
              stack: s.stack ?? (stacked ? "all" : `s${i}`),
              order: s.type === "line" ? 0 : 1,
              maxBarThickness: 36,
            };
          }) as ChartConfiguration["data"]["datasets"],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          indexAxis: horizontal ? "y" : "x",
          interaction: { mode: "index", intersect: false, axis: horizontal ? "y" : "x" },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: c.surface,
              titleColor: c.text,
              bodyColor: c.text,
              borderColor: c.grid,
              borderWidth: 1,
              padding: 10,
              titleFont: { size: 13, weight: "bold" },
              bodyFont: { size: 13 },
              boxPadding: 4,
              callbacks: {
                label: (ctx) =>
                  ` ${ctx.dataset.label}: ${formatValue(horizontal ? ctx.parsed.x : ctx.parsed.y, format)}${highlightNote(series[ctx.datasetIndex], ctx.dataIndex)}`,
              },
            },
          },
          scales: {
            [categoryAxis]: {
              stacked,
              grid: { display: false },
              border: { color: c.grid },
              ticks: {
                color: c.muted,
                font: { size: 12 },
                maxRotation: 0,
                autoSkip: !horizontal,
                autoSkipPadding: 12,
                callback(this: { getLabelForValue: (v: number) => string }, v: string | number) {
                  return short(this.getLabelForValue(Number(v)));
                },
              },
            },
            [valueAxis]: {
              stacked,
              beginAtZero,
              grid: { color: c.grid },
              border: { display: false },
              ticks: {
                color: c.muted,
                font: { size: 12 },
                maxTicksLimit: 6,
                // Whole units only: no "$1, $1, $1" on a small or empty scale.
                precision: format === "ratio" || format === "pct" ? undefined : 0,
                callback: (v: string | number) => formatValue(Number(v), format, true),
              },
            },
          },
        },
        // An "n/a" on the axis where a value is missing, so a gap never reads as zero.
        plugins: gaps?.length
          ? [
              {
                id: "gaps",
                afterDatasetsDraw(chart) {
                  const cat = chart.scales[categoryAxis];
                  const val = chart.scales[valueAxis];
                  if (!cat || !val) return;
                  const ctx = chart.ctx;
                  ctx.save();
                  ctx.fillStyle = c.muted;
                  ctx.font = "12px 'Helvetica Neue', Helvetica, Arial, sans-serif";
                  ctx.textAlign = horizontal ? "left" : "center";
                  ctx.textBaseline = horizontal ? "middle" : "bottom";
                  // Many narrow weeks in a row: thin the marks so they never overlap (every gap is still in the table and the reasons).
                  const room = ctx.measureText("n/a").width + 4;
                  let lastAlong = -Infinity;
                  for (const i of gaps) {
                    const along = cat.getPixelForValue(i);
                    if (!horizontal && along - lastAlong < room) continue;
                    lastAlong = along;
                    const zero = val.getPixelForValue(0);
                    if (horizontal) ctx.fillText("n/a", zero + 4, along);
                    else ctx.fillText("n/a", along, zero - 4);
                  }
                  ctx.restore();
                },
              },
            ]
          : [],
      };
      chartRef.current?.destroy();
      chartRef.current = new m.Chart(canvas, config);

    })();
    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // `signature` stands for labels, series and the options built from them;
    // `theme` redraws in the other theme's colours.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, theme, empty]);

  function show(index: number | null) {
    const chart = chartRef.current;
    setActive(index);
    if (!chart) return;
    if (index == null) {
      chart.setActiveElements([]);
      chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
    } else {
      const els = chart.data.datasets.map((_, datasetIndex) => ({ datasetIndex, index })).filter((e) => chart.getDatasetMeta(e.datasetIndex).visible);
      const meta = chart.getDatasetMeta(0).data[index] as { x?: number; y?: number } | undefined;
      chart.setActiveElements(els);
      chart.tooltip?.setActiveElements(els, { x: meta?.x ?? 0, y: meta?.y ?? 0 });
    }
    chart.update("none");
  }

  function onKey(e: React.KeyboardEvent) {
    if (labels.length === 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      const next = active == null ? (step > 0 ? 0 : labels.length - 1) : Math.max(0, Math.min(labels.length - 1, active + step));
      show(next);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      show(e.key === "Home" ? 0 : labels.length - 1);
    } else if (e.key === "Escape") {
      show(null);
    }
  }

  const activeText =
    active == null ? "" : `${labels[active]}: ${series.map((s) => `${s.label} ${formatValue(s.values[active], format)}${highlightNote(s, active)}`).join(", ")}`;

  const numbersToggle = (
    <div className="mt-1 flex justify-end">
      <button
        type="button"
        onClick={() => setShowTable((v) => !v)}
        aria-expanded={showTable}
        aria-controls={tableId}
        aria-label={`${showTable ? "Hide" : "Show"} numbers: ${heading ?? title}`}
        className="min-h-[44px] px-3 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white underline underline-offset-2"
      >
        {showTable ? "Hide numbers" : "Show numbers"}
      </button>
    </div>
  );

  if (empty && emptyText)
    return (
      <div>
        {heading && <h3 className="text-sm font-medium text-slate-800 dark:text-slate-100 mb-1">{heading}</h3>}
        <p className="text-sm text-slate-600 dark:text-slate-400 py-6 text-center">{emptyText}</p>
        {/* A card's own table still has its reasons and exact figures with no chart to draw. */}
        {table && numbersToggle}
        {table && showTable && <div id={tableId}>{table}</div>}
      </div>
    );

  return (
    <div className="min-w-0">
      {heading && <h3 className="text-sm font-medium text-slate-800 dark:text-slate-100 mb-1">{heading}</h3>}
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 mb-2 text-xs text-slate-600 dark:text-slate-300" aria-label="Legend">
          {series.map((s) => (
            <li key={s.label} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block"
                style={
                  s.type === "line" && !s.area
                    ? { width: 16, height: 0, borderTop: `2px ${s.dashed ? "dashed" : "solid"} var(${VAR[s.color]})` }
                    : { width: 10, height: 10, borderRadius: 2, background: `var(${VAR[s.color]})` }
                }
              />
              {s.label}
            </li>
          ))}
          {series
            .filter((s) => s.highlight)
            .map((s) => (
              <li key={`${s.label}-highlight`} className="flex items-center gap-1.5">
                <span aria-hidden="true" className="inline-block" style={{ width: 10, height: 10, borderRadius: 2, background: `var(${VAR[s.highlight!.color]})` }} />
                {s.highlight!.label}
              </li>
            ))}
        </ul>
      )}
      <div style={{ height }} className="relative">
        <canvas
          ref={canvasRef}
          role="img"
          tabIndex={0}
          aria-label={`${title}. Chart; use the left and right arrow keys to read each point, or Show numbers for a table.`}
          aria-describedby={hintId}
          onKeyDown={onKey}
          onBlur={() => show(null)}
          className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        />
      </div>
      <p id={hintId} className="sr-only" aria-live="polite">
        {activeText}
      </p>
      {numbersToggle}
      {showTable && table && <div id={tableId}>{table}</div>}
      {showTable && !table && (
        <div id={tableId} className="overflow-x-auto max-w-full">
          <table className="w-full text-sm tabular-nums mb-2">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                <th scope="col" className="py-1 pr-3 font-medium">{tableLabel}</th>
                {series.map((s) => (
                  <th key={s.label} scope="col" className="py-1 pl-3 font-medium text-right whitespace-nowrap">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={`${l}-${i}`} className="border-t border-slate-100 dark:border-slate-800">
                  <th scope="row" className="py-1 pr-3 text-left font-normal text-slate-600 dark:text-slate-300">{l}</th>
                  {series.map((s) => (
                    <td key={s.label} className="py-1 pl-3 text-right text-slate-900 dark:text-slate-100">{formatValue(s.values[i], format)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
