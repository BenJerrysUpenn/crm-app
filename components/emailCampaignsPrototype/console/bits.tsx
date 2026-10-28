"use client";

// PROTOTYPE (bj-finance #811), throwaway. Glyphs, badges and bullet graphs for
// the one-screen console. Gray at rest; colour only for a state that needs a
// person. No green anywhere.

import type { ReactNode } from "react";
import type { AttentionItem, Level, Rollup } from "@/lib/emailCampaignsPrototype/console/attention";

export type Mark = Level | "nodata" | "off" | "affected";

const GLYPH: Record<Mark, { ch: string; cls: string; word: string }> = {
  warning: { ch: "■", cls: "text-red-500", word: "warning" },
  caution: { ch: "▲", cls: "text-amber-400", word: "caution" },
  ready: { ch: "●", cls: "text-sky-400", word: "ready" },
  nodata: { ch: "◌", cls: "text-slate-500", word: "no data" },
  off: { ch: "○", cls: "text-slate-500", word: "off" },
  affected: { ch: "◇", cls: "text-slate-300", word: "affected" },
};

export const LEVEL_TEXT: Record<Level, string> = {
  warning: "text-red-400",
  caution: "text-amber-300",
  ready: "text-sky-300",
};
export const LEVEL_BORDER: Record<Level, string> = {
  warning: "border-red-500",
  caution: "border-amber-400",
  ready: "border-sky-400",
};

export function Glyph({ mark, className = "" }: { mark: Mark; className?: string }) {
  const g = GLYPH[mark];
  return (
    <span aria-hidden className={`${g.cls} ${className}`} style={{ textShadow: "0 0 1px #020617" }}>
      {g.ch}
    </span>
  );
}

const cap99 = (n: number) => (n > 99 ? "99+" : String(n));

/** R1: shape and colour for the worst state below, a number for how many
 * open items. Renders nothing at rest. Hover lists up to three paths (R5). */
export function Badge({ r, label }: { r: Rollup; label: string }) {
  if (!r.level) return null;
  const words = `${label}: ${r.count} open, worst ${GLYPH[r.level].word}. ${r.items
    .slice(0, 3)
    .map((i) => i.title)
    .join("; ")}`;
  return (
    <span className="group relative inline-flex items-center gap-0.5 text-xs font-semibold" aria-label={words} role="img">
      <Glyph mark={r.level} />
      <span className={LEVEL_TEXT[r.level]}>{cap99(r.count)}</span>
      <HoverPaths items={r.items} />
    </span>
  );
}

export function HoverPaths({ items }: { items: AttentionItem[] }) {
  if (!items.length) return null;
  return (
    <span className="pointer-events-none absolute left-0 top-full z-40 mt-1 hidden w-72 rounded border border-slate-600 bg-slate-900 p-2 text-left text-[11px] font-normal text-slate-200 shadow-lg group-hover:block">
      {items.slice(0, 3).map((i) => (
        <span key={i.id} className="block py-0.5">
          <Glyph mark={i.level} /> {i.title}
          <span className="block text-slate-400">{i.pathLabel}</span>
        </span>
      ))}
      {items.length > 3 ? <span className="block text-slate-400">+{items.length - 3} more</span> : null}
      <span className="mt-1 block text-slate-500">computed on page load</span>
    </span>
  );
}

/** Few's bullet graph: bar = value, tick = target, shading = normal band. */
export function Bullet({
  value,
  target,
  band,
  width = 96,
  dim = false,
}: {
  value: number;
  target: number | null;
  band?: [number, number] | null;
  width?: number;
  dim?: boolean;
}) {
  const max = Math.max(target ?? 0, value, band?.[1] ?? 0, 1) * 1.1;
  const x = (v: number) => (v / max) * width;
  return (
    <svg width={width} height={12} className={dim ? "opacity-40" : ""} aria-hidden>
      <rect x={0} y={2} width={width} height={8} className="fill-slate-800" />
      {band ? <rect x={x(band[0])} y={2} width={Math.max(1, x(band[1]) - x(band[0]))} height={8} className="fill-slate-700" /> : null}
      <rect x={0} y={4} width={x(value)} height={4} className="fill-slate-300" />
      {target !== null ? <rect x={x(target) - 0.5} y={0} width={1.5} height={12} className="fill-slate-100" /> : null}
    </svg>
  );
}

export function Spark({ values, width = 140 }: { values: number[]; width?: number }) {
  const max = Math.max(...values, 1);
  const w = width / values.length;
  return (
    <svg width={width} height={20} aria-hidden>
      {values.map((v, i) => (
        <rect key={i} x={i * w + 1} y={20 - (v / max) * 18} width={Math.max(1, w - 2)} height={(v / max) * 18} className="fill-slate-400" />
      ))}
    </svg>
  );
}

export function NoData({ children = "No data" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-dashed border-slate-600 px-1 text-[11px] text-slate-500">
      <Glyph mark="nodata" /> {children}
    </span>
  );
}

/** "2 of 61", or "too early" in gray under the sample bar. */
export function Rate({ k, n, min }: { k: number; n: number; min: number }) {
  if (n < min)
    return (
      <span className="text-slate-500">
        {k} of {n} · too early ({n} of {min})
      </span>
    );
  return (
    <span>
      {k} of {n} · {((k / n) * 100).toFixed(1)}%
    </span>
  );
}

export function SyntheticTag({ what }: { what?: string }) {
  if (!what) return null;
  return (
    <span title={what} className="ml-1 rounded bg-fuchsia-900/60 px-1 text-[10px] font-semibold uppercase tracking-wide text-fuchsia-200">
      synthetic
    </span>
  );
}
