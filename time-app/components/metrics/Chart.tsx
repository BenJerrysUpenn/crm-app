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

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Chart as ChartType, ChartConfiguration } from "chart.js";

export type SeriesColor = "in_store" | "catering" | "concessions" | "orange" | "target" | "serious" | "muted";
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
  muted: "--m-muted",
};

export function formatValue(v: number | null | undefined, format: ValueFormat, compact = false): string {
  if (v == null || Number.isNaN(v)) return "–";
  switch (format) {
    case "money": {
      const abs = Math.abs(v);
      if (compact && abs >= 1000) return `${v < 0 ? "-" : ""}$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}K`;
      return `${v < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { maximumFractionDigits: compact ? 0 : 2, minimumFractionDigits: compact ? 0 : abs % 1 ? 2 : 0 })}`;
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
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ChartType | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const hintId = useId();

  const signature = useMemo(() => JSON.stringify({ labels, series, format, stacked, beginAtZero }), [labels, series, format, stacked, beginAtZero]);

  useEffect(() => {
    let cancelled = false;
    let observer: MutationObserver | null = null;
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
              backgroundColor: s.area ? alpha(c.series[i], 0.35) : line ? "transparent" : c.series[i],
              fill: s.area ? (firstArea ? "origin" : "-1") : false,
              borderColor: line ? c.series[i] : c.surface,
              borderWidth: line ? 2 : stacked ? { top: 2 } : 0,
              borderDash: s.dashed ? [6, 4] : undefined,
              borderRadius: line ? 0 : 4,
              borderSkipped: "bottom",
              pointRadius: line ? (labels.length > 20 || s.area ? 0 : 3) : 0,
              pointHoverRadius: 5,
              pointBackgroundColor: c.series[i],
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
          interaction: { mode: "index", intersect: false },
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
              callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${formatValue(ctx.parsed.y, format)}` },
            },
          },
          scales: {
            x: {
              stacked,
              grid: { display: false },
              border: { color: c.grid },
              ticks: { color: c.muted, font: { size: 12 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 },
            },
            y: {
              stacked,
              beginAtZero,
              grid: { color: c.grid },
              border: { display: false },
              ticks: { color: c.muted, font: { size: 12 }, maxTicksLimit: 6, callback: (v) => formatValue(Number(v), format, true) },
            },
          },
        },
      };
      chartRef.current?.destroy();
      chartRef.current = new m.Chart(canvas, config);

      observer = new MutationObserver(() => {
        const chart = chartRef.current;
        if (!chart) return;
        const n = colours();
        chart.data.datasets.forEach((ds, i) => {
          const s = series[i];
          const line = s.type === "line" || s.area;
          (ds as { backgroundColor?: unknown }).backgroundColor = s.area ? alpha(n.series[i], 0.35) : line ? "transparent" : n.series[i];
          (ds as { borderColor?: unknown }).borderColor = line ? n.series[i] : n.surface;
          (ds as { pointBackgroundColor?: unknown }).pointBackgroundColor = n.series[i];
        });
        const o = chart.options as any;
        o.plugins.tooltip.backgroundColor = n.surface;
        o.plugins.tooltip.titleColor = n.text;
        o.plugins.tooltip.bodyColor = n.text;
        o.plugins.tooltip.borderColor = n.grid;
        o.scales.x.ticks.color = n.muted;
        o.scales.x.border.color = n.grid;
        o.scales.y.ticks.color = n.muted;
        o.scales.y.grid.color = n.grid;
        chart.update("none");
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    })();
    return () => {
      cancelled = true;
      observer?.disconnect();
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // `signature` stands for labels, series and the options built from them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  function show(index: number | null) {
    const chart = chartRef.current;
    setActive(index);
    if (!chart) return;
    if (index == null) {
      chart.setActiveElements([]);
      chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
    } else {
      const els = chart.data.datasets.map((_, datasetIndex) => ({ datasetIndex, index })).filter((e) => chart.getDatasetMeta(e.datasetIndex).visible);
      const meta = chart.getDatasetMeta(0).data[index];
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
    active == null ? "" : `${labels[active]}: ${series.map((s) => `${s.label} ${formatValue(s.values[active], format)}`).join(", ")}`;

  return (
    <div>
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
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          aria-expanded={showTable}
          aria-controls={tableId}
          className="min-h-[44px] px-3 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white underline underline-offset-2"
        >
          {showTable ? "Hide numbers" : "Show numbers"}
        </button>
      </div>
      {showTable && (
        <div id={tableId} className="overflow-x-auto max-w-full">
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                <th scope="col" className="py-1 pr-3 font-medium">{tableLabel}</th>
                {series.map((s) => (
                  <th key={s.label} scope="col" className="py-1 pl-3 font-medium text-right">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={`${l}-${i}`} className="border-t border-slate-100 dark:border-slate-800">
                  <th scope="row" className="py-1 pr-3 text-left font-normal text-slate-600 dark:text-slate-300 whitespace-nowrap">{l}</th>
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
