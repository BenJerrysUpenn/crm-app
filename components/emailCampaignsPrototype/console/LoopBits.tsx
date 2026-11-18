"use client";

// PROTOTYPE (bj-finance #811 rounds 3 and 4, #964), throwaway. The weekly
// email loop on the one-screen console: the toolbar pills, the loop region,
// its charts and its panels. Gray at rest; colour only through badges.
// Every action button is a prototype and does nothing.
//
// The header is one row of pills that never wraps or scrolls; the hand-run
// lanes are not drawn (their sends are the loop's starting data); tests are
// pooled across types; send time is a test; a judge reads every email whole;
// approaches carry their purpose, evidence and stop rule; one email has a
// button bar that walks the filtered list.

import { useMemo, useState, type ReactNode } from "react";
import type { AttentionItem, Level, Rollup } from "@/lib/emailCampaignsPrototype/console/attention";
import { rollup } from "@/lib/emailCampaignsPrototype/console/attention";
import {
  EARLY_REPLIES,
  SOURCE_WORD,
  TIER_WORD,
  VERDICT_WORD,
  isEarly,
  typeLabel,
  weeksToDecide,
  weeksWord,
  type ArmFact,
  type DraftFact,
  type EvidenceFact,
  type LoopFacts,
  type RateFact,
  type TestFact,
  type TypeFact,
} from "@/lib/emailCampaignsPrototype/console/loop";
import type { LoopAct } from "@/lib/emailCampaignsPrototype/console/loopActions";
import { dateEt, dowEt, timeEt } from "@/lib/emailCampaignsPrototype/console/time";
import { Badge, Bullet, Glyph, SyntheticTag } from "./bits";

export type LoopNav = { panel?: string; sel?: string; layer?: string; modal?: string; tab?: string; dim?: string };
type Go = (n: LoopNav) => void;

// A loop date is a day ("YYYY-MM-DD") or a timestamp; both read as that day
// at noon Eastern, so a timestamp cannot make an invalid date (2026-11-18:
// a test's start, a timestamp, crashed every test panel).
const asDay = (x: string) => `${x.slice(0, 10)}T17:00:00Z`;
const day = (ymd: string) => dateEt(asDay(ymd));
const dow = (ymd: string) => dowEt(asDay(ymd));
const pct = (x: number | null) => (x === null ? "?" : `${Math.round(x * 100)}%`);
const r1 = (x: number | null) => (x === null ? "?" : x >= 10 ? x.toFixed(0) : x.toFixed(1));
export const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();
const daysUntil = (from: string, to: string) => Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000);

export function approachName(L: LoopFacts, id: string) {
  return L.approaches[id]?.name ?? L.slots[id]?.label ?? id;
}

// ---------------------------------------------------------------------------
// Icons and pills (the toolbar)
// ---------------------------------------------------------------------------

const ICON: Record<string, ReactNode> = {
  alert: <path d="M8 2 L14.5 13.5 H1.5 Z M8 6.5 V9.5 M8 11.5 V11.6" />,
  reply: <path d="M6.5 4 L2.5 7.5 L6.5 11 M2.5 7.5 H10 a3.5 3.5 0 0 1 3.5 3.5 V13" />,
  approve: <path d="M2.5 8.5 L6 12 L13.5 4.5" />,
  memo: <path d="M3.5 1.5 H10 L12.5 4 V14.5 H3.5 Z M5.5 7 H10.5 M5.5 9.5 H10.5 M5.5 12 H8.5" />,
  limits: <path d="M3 4 H13 M3 8 H13 M3 12 H13 M6 2.5 V5.5 M10 6.5 V9.5 M5 10.5 V13.5" />,
  research: <path d="M7 2.5 a4.5 4.5 0 1 1 0 9 a4.5 4.5 0 1 1 0 -9 M10.3 10.3 L14 14" />,
  notes: <path d="M10.5 2.5 L13.5 5.5 L6 13 H3 V10 Z" />,
  history: <path d="M8 2 a6 6 0 1 1 -6 6 M2 3.5 V8 H6.5 M8 5 V8 L10.5 9.5" />,
  sending: <path d="M1.5 7.5 L14.5 2 L10 14.5 L7.5 9 Z M7.5 9 L14.5 2" />,
  pause: <path d="M5.5 3 V13 M10.5 3 V13" />,
  play: <path d="M4.5 2.5 L13 8 L4.5 13.5 Z" />,
  more: <path d="M3.5 8 h0.1 M8 8 h0.1 M12.5 8 h0.1" strokeWidth={2.4} />,
  search: <path d="M6.5 2 a4.5 4.5 0 1 1 0 9 a4.5 4.5 0 1 1 0 -9 M10 10 L14 14" />,
};

export function Icon({ name }: { name: keyof typeof ICON }) {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      {ICON[name]}
    </svg>
  );
}

const PILL_TONE: Record<Level, string> = {
  warning: "border-red-500/70 text-red-300",
  caution: "border-amber-400/70 text-amber-200",
  ready: "border-sky-400/70 text-sky-200",
};

/** One toolbar pill: icon, a label that hides on narrow screens, a count. */
export function Pill({
  icon,
  label,
  count,
  level,
  onClick,
  title,
  className = "",
  strong,
}: {
  icon: keyof typeof ICON;
  label: ReactNode;
  count?: ReactNode;
  level?: Level | null;
  onClick: (e: React.MouseEvent) => void;
  title?: string;
  className?: string;
  strong?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-xs hover:bg-slate-900 ${
        level ? PILL_TONE[level] : "border-slate-700 text-slate-400"
      } ${strong ? "font-semibold" : ""} ${className}`}
    >
      <Icon name={icon} />
      <span className="pill-label hidden xl:inline">{label}</span>
      {count !== undefined && count !== null && count !== "" ? <span className="tabular-nums">{count}</span> : null}
    </button>
  );
}

/** The two loop pills Alina asked for: the week's approval and its memo. */
export function loopPills(L: LoopFacts, items: AttentionItem[]) {
  const week = rollup(items, ["loop", "week"]);
  const emails = rollup(items, ["loop", "emails"]);
  const planned = L.drafts.filter((d) => d.status === "planned").length;
  const runBad = !L.run || !L.run.check.ok;
  const approve = runBad
    ? { label: L.run ? "Run stopped" : "No weekly run", count: "", level: "warning" as Level, title: L.run ? L.run.check.text : `No weekly run for the week of ${day(L.weekStart)}` }
    : L.gate && !L.run!.approvedAt
      ? { label: "Approve", count: planned, level: emails.level, title: `Weekly run ${dowEt(L.run!.createdAt)} ${timeEt(L.run!.createdAt)} · ${L.run!.planned} emails this week · nothing sends until you approve` }
      : { label: "Sending", count: `${L.drafts.filter((d) => d.status === "sent").length}/${L.drafts.length}`, level: emails.level, title: `Approved ${L.run!.approvedAt ? dateEt(L.run!.approvedAt) : ""}` };
  const asks = L.run?.asks.filter((a) => !a.answered).length ?? 0;
  return { approve, memo: { level: runBad ? null : week.level, asks, title: L.run?.memo ?? "No memo: the weekly run has not logged this week." } };
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

type Metric = "reply" | "lead" | "booking";
const METRIC_WORD: Record<Metric, string> = { reply: "Replies", lead: "Leads", booking: "Bookings" };

function scaleFor(arms: ArmFact[], metric: Metric) {
  // Points always count; ranges only once an arm has 5 replies (a range on 2
  // replies would squash every other row). Longer lines are clipped.
  const live = arms.filter((a) => a.status !== "retired");
  const vals = live.flatMap((a) => [(a[metric].per1000 ?? 0) * 1.4, isEarly(a) ? 0 : (a[metric].hi ?? 0)]);
  return Math.ceil(Math.max(10, ...vals) / 10) * 10;
}

/** A test row's strip: one dot per live arm at its replies per 1,000, a line
 * for the 90% range. Hollow = baseline, gray = under 5 replies. */
export function ArmStrip({ arms, L, width = 200 }: { arms: ArmFact[]; L: LoopFacts; width?: number }) {
  const live = arms.filter((a) => a.status !== "retired" && a.reply.n > 0);
  const max = scaleFor(live, "reply");
  const h = Math.max(16, live.length * 7 + 4);
  const x = (v: number | null) => 4 + (Math.min(v ?? 0, max) / max) * (width - 8);
  return (
    <svg width={width} height={h} role="img" aria-label={live.map((a) => `${approachName(L, a.approachId)} ${r1(a.reply.per1000)} replies per 1,000`).join("; ")}>
      <line x1={4} x2={width - 4} y1={h - 1} y2={h - 1} className="stroke-slate-800" />
      {live.map((a, i) => {
        const y = 4 + i * 7;
        const early = isEarly(a);
        const base = a.verdict === "baseline";
        return (
          <g key={a.approachId}>
            <title>{`${approachName(L, a.approachId)}: ${a.reply.k} replies in ${a.reply.n} emails, ${r1(a.reply.per1000)} per 1,000 (range ${r1(a.reply.lo)} to ${r1(a.reply.hi)})${early ? ", too early" : ""}`}</title>
            {early ? null : <line x1={x(a.reply.lo)} x2={x(a.reply.hi)} y1={y} y2={y} className="stroke-slate-500" strokeWidth={1.5} />}
            {!early && (a.reply.hi ?? 0) > max ? <path d={`M ${width - 4} ${y - 2} l 3 2 l -3 2`} className="fill-slate-600" /> : null}
            <circle cx={x(a.reply.per1000)} cy={y} r={3} className={base ? "fill-slate-950 stroke-slate-300" : early ? "fill-slate-600" : "fill-slate-200"} strokeWidth={base ? 1.2 : 0} />
          </g>
        );
      })}
    </svg>
  );
}

/** The panel chart: one row per arm, the rate and its range, with the
 * chance of being best as a bar beside it. */
function Forest({ rows, metric }: { rows: { label: string; a: ArmFact }[]; metric: Metric }) {
  const scale = scaleFor(
    rows.map((r) => r.a),
    metric,
  );
  const W = 200;
  const x = (v: number | null) => 2 + (Math.min(v ?? 0, scale) / scale) * (W - 4);
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[110px_200px_1fr] items-end gap-2 text-[10px] text-slate-500">
        <span />
        <span className="flex justify-between">
          <span>0</span>
          <span>{scale / 2}</span>
          <span>{scale} per 1,000</span>
        </span>
        <span>chance of best</span>
      </div>
      {rows.map(({ label, a }) => {
        const r = a[metric];
        const early = isEarly(a);
        const base = a.verdict === "baseline";
        return (
          <div key={label} className={`grid grid-cols-[110px_200px_1fr] items-center gap-2 text-xs ${a.status === "retired" ? "opacity-50" : ""}`}>
            <span className="truncate text-slate-300" title={label}>
              {label}
            </span>
            <svg width={W} height={14} role="img" aria-label={`${label}: ${r.k} of ${r.n}, ${r1(r.per1000)} per 1,000, range ${r1(r.lo)} to ${r1(r.hi)}`}>
              <line x1={2} x2={W - 2} y1={7} y2={7} className="stroke-slate-800" />
              {r.n ? <line x1={x(r.lo)} x2={x(r.hi)} y1={7} y2={7} className={early ? "stroke-slate-700" : "stroke-slate-400"} strokeWidth={2} /> : null}
              {(r.hi ?? 0) > scale ? <path d={`M ${W - 5} 4 l 4 3 l -4 3`} className="fill-slate-500" /> : null}
              {r.n ? <circle cx={x(r.per1000)} cy={7} r={3.5} className={base ? "fill-slate-900 stroke-slate-200" : early ? "fill-slate-500" : "fill-slate-100"} strokeWidth={base ? 1.4 : 0} /> : null}
            </svg>
            <span className="flex items-center gap-1">
              <svg width={60} height={8} aria-hidden>
                <rect width={60} height={8} className="fill-slate-800" />
                <rect width={60 * (a.best ?? 0)} height={8} className="fill-slate-400" />
              </svg>
              <span className="tabular-nums text-slate-400">{a.status === "retired" ? "set aside" : r.n ? pct(a.best) : "new"}</span>
            </span>
          </div>
        );
      })}
      <p className="text-[10px] text-slate-600">dot = rate · line = 90% range · hollow = baseline · gray = under {EARLY_REPLIES} replies (too early)</p>
    </div>
  );
}

function MetricTabs({ metric, set }: { metric: Metric; set: (m: Metric) => void }) {
  return (
    <div className="mb-1 flex gap-1">
      {(Object.keys(METRIC_WORD) as Metric[]).map((m) => (
        <button key={m} type="button" onClick={() => set(m)} className={`rounded border px-1.5 text-[11px] ${metric === m ? "border-slate-400 text-slate-100" : "border-slate-700 text-slate-500"}`}>
          {METRIC_WORD[m]}
        </button>
      ))}
    </div>
  );
}

function ShowNumbers({ children, label = "Show numbers" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-[11px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline">
        {open ? "Hide" : label}
      </button>
      {open ? <div className="mt-1 space-y-0.5 text-[11px] tabular-nums text-slate-400">{children}</div> : null}
    </div>
  );
}

const rateLine = (r: RateFact) => `${r.k} of ${r.n} · ${r1(r.per1000)} per 1,000 (${r1(r.lo)} to ${r1(r.hi)})`;

function Evidence({ list }: { list: EvidenceFact[] }) {
  if (!list.length) return <p className="text-xs text-slate-500">No source recorded.</p>;
  return (
    <ul className="space-y-1.5">
      {list.map((e) => (
        <li key={e.source} className="text-xs">
          <p className="text-slate-200">
            {e.url ? (
              <a href={e.url} target="_blank" rel="noreferrer" className="underline decoration-slate-600 underline-offset-2 hover:decoration-slate-300">
                {e.source}
              </a>
            ) : (
              e.source
            )}
          </p>
          <p className="text-slate-400">{e.finding}</p>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The loop region
// ---------------------------------------------------------------------------

export function testLeader(L: LoopFacts, t: TestFact) {
  const live = t.arms.filter((a) => a.status === "live" && a.reply.n > 0).sort((a, b) => (b.best ?? 0) - (a.best ?? 0));
  const top = live[0];
  if (!top || live.every(isEarly)) return "too early";
  return `${approachName(L, top.approachId)} · ${pct(top.best)} best`;
}

export function LoopRegion({ L, items, go, fade }: { L: LoopFacts; items: AttentionItem[]; go: Go; fade: (has: boolean) => string }) {
  const loopR = rollup(items, ["loop"]);
  const grid = "grid w-full grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_200px_minmax(0,170px)_minmax(0,110px)]";
  const tgrid = "grid w-full grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)_64px_minmax(0,150px)]";
  const tiers = (["warm", "cold"] as const).map((t) => ({ t, rows: L.types.filter((x) => x.tier === t) })).filter((g) => g.rows.length);
  return (
    <section aria-label="The loop" className="mt-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
        The loop <Badge r={loopR} label="The loop" />
        <button type="button" onClick={() => go({ panel: "history" })} className="ml-auto flex items-center gap-1 normal-case tracking-normal hover:text-slate-300">
          <Icon name="history" /> Started from what we sent by hand
        </button>
      </div>

      {/* Tests: one question at a time, pooled across types */}
      <div className={`${grid} mt-1 text-[11px] text-slate-500`}>
        <span>Testing now</span>
        <span className="hidden sm:block">replies per 1,000</span>
        <span className="hidden sm:block">ahead</span>
        <span className="text-right sm:text-left">decides in</span>
      </div>
      {L.tests.map((t) => {
        const r = rollup(items, ["loop", `test:${t.id}`]);
        const w = weeksToDecide(t, L.limits.baselineShare);
        return (
          <button key={t.id} type="button" onClick={() => go({ panel: `test:${t.id}` })} className={`${grid} rounded border-t border-slate-800 py-1 text-left text-sm hover:bg-slate-900 ${fade(r.count > 0)}`}>
            <span className="min-w-0 truncate text-slate-100">
              {t.question} <Badge r={r} label={t.question} />
              <span className="ml-1 text-xs text-slate-500">{t.weekly} a week</span>
            </span>
            <span className="hidden sm:block">
              <ArmStrip arms={t.arms} L={L} />
            </span>
            <span className="hidden truncate text-xs text-slate-400 sm:block">{testLeader(L, t)}</span>
            <span className="truncate text-right text-xs text-slate-400 sm:text-left">{weeksWord(w)}</span>
          </button>
        );
      })}

      {/* Customer types */}
      <div className={`${tgrid} mt-3 text-[11px] text-slate-500`}>
        <span>Who gets emailed</span>
        <span className="hidden sm:block">aimed at</span>
        <span className="text-right">this week</span>
        <span className="hidden sm:block">most get</span>
      </div>
      {tiers.map(({ t, rows }) => (
        <div key={t} className="border-t border-slate-800 pt-0.5">
          <p className="flex items-center gap-2 text-[11px] text-slate-500">
            {TIER_WORD[t]}
            <span className="text-slate-600">
              · {L.volume[t].ready.toLocaleString()} waiting to send · room for {L.volume[t].room} a week
            </span>
          </p>
          {rows.filter((x) => x.emailsThisWeek > 0 || rollup(items, ["loop", `type:${x.key}`]).count > 0).map((x) => {
            const r = rollup(items, ["loop", `type:${x.key}`]);
            return (
              <button key={x.key} type="button" onClick={() => go({ panel: `type:${x.key}` })} className={`${tgrid} rounded py-[1px] text-left text-sm hover:bg-slate-900 ${fade(r.count > 0)}`}>
                <span className="flex min-w-0 items-center gap-1.5 truncate pl-2 text-slate-200">
                  {x.label} <Badge r={r} label={x.label} />
                </span>
                <span className="hidden truncate text-xs text-slate-400 sm:block">{x.target ? `${x.target.name} · ${day(x.target.aim)}` : <span className="text-slate-600">no occasion this week</span>}</span>
                <span className="text-right text-xs tabular-nums text-slate-300">{x.emailsThisWeek}</span>
                <span className="hidden truncate text-xs text-slate-500 sm:block">{x.mostly ? approachName(L, x.mostly) : ""}</span>
              </button>
            );
          })}
          {(() => {
            const quiet = rows.filter((x) => x.emailsThisWeek === 0 && rollup(items, ["loop", `type:${x.key}`]).count === 0);
            return quiet.length ? (
              <p className="pl-2 text-[11px] text-slate-600" title={quiet.map((x) => x.label).join(", ")}>
                {quiet.length} more type{quiet.length === 1 ? "" : "s"} with no emails this week
              </p>
            ) : null;
          })()}
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

type PanelBits = {
  L: LoopFacts;
  items: AttentionItem[];
  nav: LoopNav;
  go: Go;
  say: (s: string) => void;
  Proto: (p: { label: string; onClick?: () => void; primary?: boolean }) => ReactNode;
  act: LoopAct;
  Row: (p: { k: string; children: ReactNode }) => ReactNode;
  Alerts: (p: { items: AttentionItem[] }) => ReactNode;
};

const scopeWord = (type: string | null) => (!type ? "" : type.startsWith("cold") ? " for new-to-us people" : ` for ${typeLabel(type).toLowerCase()}`);

const H = ({ children }: { children: ReactNode }) => <p className="mb-1 mt-3 text-[11px] uppercase tracking-wide text-slate-500">{children}</p>;

function DecisionLine({ L, d }: { L: LoopFacts; d: LoopFacts["runs"][number]["decisions"][number] }) {
  const verb = { add: "Started", retire: "Set aside", crown: "Crowned", reopen: "Reopened", hold: "Kept" }[d.kind];
  return (
    <span className="text-xs text-slate-300">
      <span className="font-semibold text-slate-100">
        {verb} “{approachName(L, d.approachId)}”
      </span>
      {scopeWord(d.type)}. <span className="text-slate-400">{d.reason}</span>
    </span>
  );
}

/** A started approach, laid out for checking: why, the evidence, the stop rule. */
function StartedCard({ L, d, go }: { L: LoopFacts; d: LoopFacts["runs"][number]["decisions"][number]; go: Go }) {
  const a = L.approaches[d.approachId];
  if (!a) return <DecisionLine L={L} d={d} />;
  return (
    <div className="rounded border border-slate-700 p-2 text-xs">
      <p className="flex items-baseline justify-between gap-2">
        <button type="button" onClick={() => go({ panel: `approach:${a.id}` })} className="font-semibold text-slate-100 underline-offset-2 hover:underline">
          {a.name}
          <span className="font-normal text-slate-400">{scopeWord(d.type)}</span>
        </button>
        <span className="text-slate-500">{a.origin === "loop" ? "the loop's own idea" : a.origin === "research" ? "from your research list" : "sent by hand before"}</span>
      </p>
      <p className="mt-1 text-slate-300">{d.reason}</p>
      <p className="mt-1">
        <span className="text-slate-500">Meant to </span>
        <span className="text-slate-300">{a.purpose.charAt(0).toLowerCase() + a.purpose.slice(1)}</span>
      </p>
      <p className="mt-1">
        <span className="text-slate-500">Stop it if </span>
        <span className="text-slate-300">{a.stopIf.charAt(0).toLowerCase() + a.stopIf.slice(1)}</span>
      </p>
      <div className="mt-1.5">
        <Evidence list={a.evidence} />
      </div>
    </div>
  );
}

export function WeekBody(p: PanelBits) {
  const { L, go } = p;
  const run = L.run;
  const started = run?.decisions.filter((d) => d.kind === "add") ?? [];
  const other = run?.decisions.filter((d) => d.kind !== "add") ?? [];
  return (
    <div className="text-sm text-slate-300">
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[1] === "week")} />
      <p className="font-semibold text-slate-100">
        Week of {day(L.weekStart)} <SyntheticTag what={L.synthetic} />
      </p>
      {run ? (
        <>
          <p className="text-xs text-slate-400">
            Run {dowEt(run.createdAt)} {timeEt(run.createdAt)} · {run.check.ok ? "check passed" : run.check.text} ·{" "}
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => go({ panel: "emails" })}>
              {run.planned} emails
            </button>
            {L.gate ? ` · ${run.approvedAt ? `approved ${dateEt(run.approvedAt)}` : "waiting for your approval"}` : ""}
          </p>
          <H>Memo</H>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-200">{run.memo}</p>
          {run.asks.length ? (
            <>
              <H>Asks you</H>
              <p className="mb-1 text-xs text-slate-500">Answer in the session that runs the loop, or by replying to the Monday email. A change to a limit goes in as a PR that quotes you.</p>
              <ul className="space-y-2">
                {run.asks.map((a) => (
                  <li key={a.id} className="rounded border border-slate-700 p-2 text-xs">
                    <p className="text-slate-200">{a.text}</p>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {started.length ? (
            <>
              <H>Started this week: check the reasoning</H>
              <div className="space-y-2">
                {started.map((d, i) => (
                  <StartedCard key={i} L={L} d={d} go={go} />
                ))}
              </div>
            </>
          ) : null}
          <H>Also decided</H>
          <ul className="space-y-1">
            {other.map((d, i) => (
              <li key={i}>
                <DecisionLine L={L} d={d} />
              </li>
            ))}
          </ul>
          <H>The judge</H>
          <p className="text-xs text-slate-300">
            Read every email whole before it was planned: {L.judge.passed} passed, {L.judge.rewritten} rewritten, {L.judge.held} held for you. You overruled it {L.judge.youOverruled} time
            {L.judge.youOverruled === 1 ? "" : "s"} last week; each one is now a test case it is checked against.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {L.gate && !run.approvedAt ? p.Proto({ label: "Read and approve the week", primary: true, onClick: () => go({ panel: "emails" }) }) : null}
            {p.Proto({ label: L.paused ? "Resume the loop…" : "Pause the loop…", onClick: () => go({ ...p.nav, modal: "pause" }) })}
          </div>
        </>
      ) : (
        <p className="mt-1 text-xs text-slate-400">No run logged for this week. The run plans the week on Monday morning; until it does, nothing new sends.</p>
      )}
      <H>Volume</H>
      {(["warm", "cold"] as const).map((t) => (
        <div key={t} className="flex items-center gap-2 text-xs">
          <span className="w-44 text-slate-400">{TIER_WORD[t]}</span>
          <Bullet value={L.volume[t].room} target={L.volume[t].ready} width={140} />
          <span className="tabular-nums">
            room {L.volume[t].room} a week · {L.volume[t].ready.toLocaleString()} ready
          </span>
        </div>
      ))}
      <H>Earlier weeks</H>
      <ul className="space-y-2">
        {L.runs
          .filter((r) => r.weekStart !== run?.weekStart)
          .map((r) => (
            <li key={r.weekStart} className="border-t border-slate-800 pt-1.5 text-xs">
              <p className="text-slate-400">
                Week of {day(r.weekStart)} · {r.planned} emails
              </p>
              <p className="text-slate-300">{firstSentence(r.memo)}</p>
              <ul className="mt-1 space-y-0.5">
                {r.decisions.map((d, i) => (
                  <li key={i}>
                    <DecisionLine L={L} d={d} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
      </ul>
    </div>
  );
}

// --- emails: the filter lives in the URL so one email can walk the list ---------

export function parseFilter(tab?: string) {
  const f = { type: "", appr: "", slot: "" };
  for (const part of (tab ?? "").split("|")) {
    const [k, v] = part.split(":");
    if (k === "t") f.type = part.slice(2);
    if (k === "a") f.appr = v ?? "";
    if (k === "s") f.slot = v ?? "";
  }
  return f;
}
const filterTab = (f: { type: string; appr: string; slot: string }) =>
  [f.type && `t:${f.type}`, f.appr && `a:${f.appr}`, f.slot && `s:${f.slot}`].filter(Boolean).join("|") || undefined;

export function filtered(L: LoopFacts, tab?: string) {
  const f = parseFilter(tab);
  return L.drafts
    .filter((d) => (!f.type || d.type === f.type) && (!f.appr || d.approachId === f.appr) && (!f.slot || d.slot === f.slot))
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt) || Number(a.id) - Number(b.id));
}

export function EmailsBody(p: PanelBits) {
  const { L, nav, go } = p;
  const f = parseFilter(nav.tab);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const shown = filtered(L, nav.tab);
  const days = [...new Set(shown.map((d) => d.sendOn))].sort();
  const set = (k: keyof typeof f, v: string) => go({ ...nav, tab: filterTab({ ...f, [k]: v }) });
  const sel = "rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-xs text-slate-200";
  return (
    <div className="text-sm text-slate-300">
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[1] === "emails" && !i.path[2])} />
      <p className="font-semibold text-slate-100">
        Emails this week <SyntheticTag what={L.synthetic} />
      </p>
      <p className="text-xs text-slate-400">Each one as it will arrive. Open one to read it, then step through the rest with the arrows.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <select aria-label="Customer type" value={f.type} onChange={(e) => set("type", e.target.value)} className={sel}>
          <option value="">Every type</option>
          {L.types.map((t) => (
            <option key={t.key} value={t.key}>
              {t.tier === "cold" ? "Cold: " : ""}
              {t.label}
            </option>
          ))}
        </select>
        <select aria-label="Approach" value={f.appr} onChange={(e) => set("appr", e.target.value)} className={sel}>
          <option value="">Every approach</option>
          {Object.values(L.approaches)
            .filter((a) => L.drafts.some((d) => d.approachId === a.id))
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        <select aria-label="Send time" value={f.slot} onChange={(e) => set("slot", e.target.value)} className={sel}>
          <option value="">Any time</option>
          {Object.values(L.slots).map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="self-center text-xs text-slate-500">{shown.length} emails</span>
      </div>
      {(L.approvals ?? []).map((a) => (
        <div key={a.approachId} className="mt-2 flex flex-wrap items-center gap-2 rounded border border-amber-500/60 p-2 text-xs">
          <span className="flex-1">
            {a.n} email{a.n === 1 ? "" : "s"} use “{approachName(L, a.approachId)}”, a new approach. They wait until you approve it.
          </span>
          {p.Proto({ label: "Read its emails", onClick: () => go({ ...nav, tab: filterTab({ ...f, appr: a.approachId }) }) })}
          {p.Proto({ label: "Approve…", primary: true, onClick: () => go({ ...nav, modal: `approve:${a.approachId}` }) })}
        </div>
      ))}
      {L.gate && L.run && !L.run.approvedAt ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-slate-700 p-2 text-xs">
          <span className="flex-1">Nothing sends until you approve. Hold any single email first, or approve them one by one.</span>
          {p.Proto({ label: `Approve all ${L.drafts.filter((d) => d.status === "planned").length}…`, primary: true, onClick: () => go({ ...nav, modal: "approve" }) })}
        </div>
      ) : null}
      {days.map((d) => {
        const list = shown.filter((x) => x.sendOn === d);
        const sent = list.filter((x) => x.status === "sent").length;
        const all = open[d];
        return (
          <div key={d} className="mt-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">
              {dow(d)} · {list.length} emails{sent ? ` · ${sent} sent` : ""}
              {d === L.today ? " · today" : ""}
            </p>
            <ul>
              {(all ? list : list.slice(0, 12)).map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => go({ panel: "emails", sel: `email:${x.id}`, tab: nav.tab })}
                    className="grid w-full grid-cols-[14px_40px_minmax(0,130px)_1fr] items-baseline gap-2 border-t border-slate-800 py-1 text-left text-xs hover:bg-slate-800/60"
                  >
                    <span className="text-slate-500">{x.status === "sent" ? "✓" : x.status === "held" ? "‖" : x.status === "skipped" ? "–" : x.waitingApproval ? "◷" : x.judge.verdict === "rewritten" ? "↻" : ""}</span>
                    <span className="tabular-nums text-slate-500">{timeEt(x.sendAt)}</span>
                    <span className="truncate text-slate-200">{x.person.name}</span>
                    <span className="truncate text-slate-400">
                      {x.subject} <span className="text-slate-600">· {approachName(L, x.approachId)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {list.length > 12 && !all ? (
              <button type="button" onClick={() => setOpen((o) => ({ ...o, [d]: true }))} className="mt-1 text-[11px] text-slate-500 hover:text-slate-300">
                Show all {list.length}
              </button>
            ) : null}
          </div>
        );
      })}
      <p className="mt-2 text-[10px] text-slate-600">✓ sent · ‖ held by you · – skipped · ◷ waiting for your approval of its approach</p>
    </div>
  );
}

/** One email's button bar: previous and next in the filtered list, and the
 * three things to do with it. */
function EmailBar(p: PanelBits & { d: DraftFact }) {
  const { L, d, go, nav } = p;
  const list = filtered(L, nav.tab);
  const i = list.findIndex((x) => x.id === d.id);
  const to = (j: number) => (list[j] ? () => go({ ...nav, sel: `email:${list[j].id}`, layer: undefined }) : undefined);
  const prev = to(i - 1);
  const next = to(i + 1);
  const f = parseFilter(nav.tab);
  const scope = [f.type && typeLabel(f.type), f.appr && approachName(L, f.appr), f.slot && L.slots[f.slot]?.label].filter(Boolean).join(", ") || "all emails";
  const btn = "rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-30";
  const planned = d.status === "planned";
  return (
    <div className="sticky -top-3 z-10 -mx-3 mb-2 flex items-center gap-1.5 border-b border-slate-700 bg-slate-900 px-3 py-2">
      <button type="button" className={btn} disabled={!prev} onClick={prev} aria-label="Previous email">
        ‹
      </button>
      <span className="min-w-0 flex-1 truncate text-center text-[11px] text-slate-500">
        {i + 1} of {list.length} · {scope}
      </span>
      {planned && d.waitingApproval ? (
        <button
          type="button"
          className={`${btn} border-slate-300 bg-slate-200 font-semibold text-slate-950 hover:bg-white`}
          onClick={() => go({ ...nav, modal: `approve:${d.approachId}` })}
        >
          Approve approach…
        </button>
      ) : null}
      {planned ? (
        <button type="button" className={btn} onClick={() => go({ ...nav, layer: "flag" })}>
          Hold…
        </button>
      ) : d.status === "held" ? (
        <button type="button" className={btn} onClick={() => void p.act({ action: "release", draft: Number(d.id) })}>
          Release
        </button>
      ) : (
        <span className="text-xs text-slate-500">{d.status === "sent" ? "Sent" : "Skipped"}</span>
      )}
      <button type="button" className={btn} disabled={!next} onClick={next} aria-label="Next email">
        ›
      </button>
    </div>
  );
}

function HoldForm(p: PanelBits & { d: DraftFact }) {
  const { d, go, nav } = p;
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="text-sm text-slate-300">
      <p className="font-semibold text-slate-100">Hold this email to {d.person.name}</p>
      <p className="mt-1 text-xs text-slate-400">
        It will not send. The rest of the week sends as planned. Say what is wrong in your words: it is kept with the email, and you can release it later.
      </p>
      <textarea
        rows={4}
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        className="mt-2 w-full rounded border border-slate-700 bg-slate-950 p-2 text-xs text-slate-100"
        placeholder="What's wrong with it…"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await p.act({ action: "hold", draft: Number(d.id), reason: why });
            setBusy(false);
            if (ok) go({ ...nav, layer: undefined });
          }}
          className="rounded bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "Holding…" : "Hold it"}
        </button>
        <button type="button" onClick={() => go({ ...nav, layer: undefined })} className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function EmailBody(p: PanelBits & { d: DraftFact }) {
  const { L, d, go, nav } = p;
  const t = L.types.find((x) => x.key === d.type);
  const away = daysUntil(d.sendOn, d.why.eventDate);
  const slot = L.slots[d.slot];
  if (nav.layer === "flag") return <HoldForm {...p} d={d} />;
  return (
    <div className="text-sm text-slate-300">
      <EmailBar {...p} />
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[2] === d.id)} />
      {d.held ? (
        <p className="mb-2 rounded border border-slate-600 p-2 text-xs text-slate-300">
          Held{d.held.by ? ` by ${d.held.by}` : ""}
          {d.held.at ? ` ${dateEt(d.held.at)} ${timeEt(d.held.at)}` : ""}
          {d.held.reason ? `: “${d.held.reason}”` : "."}
        </p>
      ) : d.waitingApproval ? (
        <p className="mb-2 rounded border border-amber-500/60 p-2 text-xs text-slate-300">Waiting for your approval of “{approachName(L, d.approachId)}”. It sends in its next send time once you approve.</p>
      ) : d.status === "skipped" && d.skipReason ? (
        <p className="mb-2 rounded border border-slate-700 p-2 text-xs text-slate-400">Skipped: {d.skipReason}</p>
      ) : null}
      <div className="rounded-md bg-white p-3 text-[13px] leading-relaxed text-slate-900 shadow">
        <div className="space-y-0.5 border-b border-slate-200 pb-2 text-xs text-slate-500">
          <p>
            <span className="inline-block w-12">From</span> {d.mailbox || "a news mailbox"}
          </p>
          <p>
            <span className="inline-block w-12">To</span> {d.person.name} &lt;{d.person.email}&gt;
          </p>
          <p>
            <span className="inline-block w-12">Lands</span> {dow(d.sendOn)}, {timeEt(d.sendAt)}
          </p>
        </div>
        <p className="mt-2 font-semibold">{d.subject}</p>
        <p className="mt-2 whitespace-pre-wrap font-sans">{d.body}</p>
      </div>
      <H>Why this email</H>
      <p.Row k="Judge">
        <span className={d.judge.verdict === "held" ? "text-amber-300" : ""}>{d.judge.verdict === "pass" ? "Passed" : d.judge.verdict === "rewritten" ? "Rewritten once, then passed" : "Held for you"}</span>
        <span className="block text-slate-400">{d.judge.note}</span>
      </p.Row>
      <p.Row k="Approach">
        <button type="button" onClick={() => go({ panel: `approach:${d.approachId}` })} className="underline-offset-2 hover:underline">
          {approachName(L, d.approachId)}
        </button>
        <span className="block text-slate-400">{d.pick}</span>
      </p.Row>
      <p.Row k="Lands">
        {slot ? `${slot.label}, ${timeEt(d.sendAt)}` : timeEt(d.sendAt)}
        {slot ? <span className="block text-slate-400">{slot.why}</span> : null}
      </p.Row>
      <H>Why this person</H>
      <p.Row k="Who">
        {d.person.company} · {t?.label ?? typeLabel(d.type)} · {d.why.relationship}
      </p.Row>
      <p.Row k="Aimed at">
        {d.why.occasion ?? "no occasion"} on {day(d.why.eventDate)} ({away} days after this email
        {away < L.limits.minDaysBeforeEvent ? <span className="text-red-400"> · under your {L.limits.minDaysBeforeEvent}-day limit</span> : null})
      </p.Row>
      <p.Row k="Date from">
        {SOURCE_WORD[d.why.source] ?? d.why.source}
        {d.why.confidence !== null ? `, ${pct(d.why.confidence)} sure` : ""}
        {d.why.basis === "occasion" ? " (the occasion's middle)" : ""}
        {d.why.evidence ? <span className="block text-slate-400">“{d.why.evidence}”</span> : null}
      </p.Row>
      <p.Row k="Email">
        {d.touch} of {d.planned}
        {d.prior.map((x) => (
          <span key={x.touch} className="block text-slate-400">
            {day(x.sentOn)} · “{x.subject}”
          </span>
        ))}
      </p.Row>
    </div>
  );
}

// --- tests, types, approaches ------------------------------------------------------

export function TestBody(p: PanelBits & { t: TestFact }) {
  const { L, t, go } = p;
  const [metric, setMetric] = useState<Metric>("reply");
  const w = weeksToDecide(t, L.limits.baselineShare);
  const base = t.arms.find((a) => a.verdict === "baseline");
  const live = t.arms.filter((a) => a.status === "live");
  const rows = t.arms.map((a) => ({ label: approachName(L, a.approachId), a }));
  const isTime = t.factor === "send time";
  return (
    <div className="text-sm text-slate-300">
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[1] === `test:${t.id}`)} />
      <p className="font-semibold text-slate-100">
        {t.question} <SyntheticTag what={L.synthetic} />
      </p>
      <p className="text-xs text-slate-400">
        {t.weekly} emails a week · since {day(t.started)} · {t.tier === "all" ? "every type" : TIER_WORD[t.tier].toLowerCase()}
      </p>
      <p className="mt-1 text-xs text-slate-300">{t.why}</p>
      <H>So far</H>
      <MetricTabs metric={metric} set={setMetric} />
      <Forest rows={rows} metric={metric} />
      <H>When it can be called</H>
      <p className="text-xs text-slate-300">
        {w === null ? "Nothing to call: no challenger is live." : w === Infinity || w > 26 ? "Not this season at this volume." : `In ${weeksWord(w)}, if one is twice as good as ${approachName(L, base?.approachId ?? "")}.`}{" "}
        <span className="text-slate-400">
          {base && base.reply.n >= 1000
            ? `${approachName(L, base.approachId)} carries ${base.reply.n.toLocaleString()} emails of history, so its rate is known and a challenger only has to prove itself.`
            : "The baseline has little history, so both sides have to fill in."}{" "}
          A smaller difference takes four times as long; one this small is not worth chasing at our volume.
        </span>
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {live.length > 2 ? p.Proto({ label: `Faster: keep the top ${live.length - 1}` }) : null}
        {p.Proto({ label: "Decide on leads instead…" })}
      </div>
      <H>{isTime ? "The slots" : "In this test"}</H>
      <ul className="space-y-1.5">
        {t.arms.map((a) => {
          const s = L.slots[a.approachId];
          return (
            <li key={a.approachId} className={`text-xs ${a.status === "retired" ? "opacity-60" : ""}`}>
              {s ? (
                <span className="font-semibold text-slate-200">
                  {s.label}, {s.at}
                </span>
              ) : (
                <button type="button" onClick={() => go({ panel: `approach:${a.approachId}` })} className="font-semibold text-slate-200 underline-offset-2 hover:underline">
                  {approachName(L, a.approachId)}
                </button>
              )}
              <span className="text-slate-400">
                {" "}
                · {a.status === "retired" ? `set aside ${day(a.since)}` : VERDICT_WORD[a.verdict]} · {a.emailsThisWeek} this week
              </span>
              <span className="block text-slate-500">{s ? s.why : a.reason}</span>
              {s ? (
                <div className="mt-1 pl-2">
                  <Evidence list={s.evidence} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ShowNumbers>
        {t.arms.map((a) => (
          <div key={a.approachId}>
            <span className="text-slate-300">{approachName(L, a.approachId)}</span>: replies {rateLine(a.reply)} · leads {rateLine(a.lead)} · bookings {rateLine(a.booking)}
          </div>
        ))}
      </ShowNumbers>
    </div>
  );
}

function Timeline({ L, t }: { L: LoopFacts; t: TypeFact }) {
  const start = L.today;
  const span = 200;
  const W = 420;
  const LABEL = 150;
  const x = (ymd: string) => LABEL + (Math.max(0, Math.min(span, daysUntil(start, ymd))) / span) * (W - LABEL - 8);
  const cutDay = new Date(new Date(`${start}T12:00:00Z`).getTime() + L.limits.minDaysBeforeEvent * 86_400_000).toISOString().slice(0, 10);
  const marks = [...(t.target ? [{ o: t.target, now: true }] : []), ...t.upcoming.map((o) => ({ o, now: false }))];
  const rowH = 14;
  const Ht = 18 + marks.length * rowH + 12;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${Ht}`} role="img" aria-label={`Occasions for ${t.label}: ${marks.map((m) => `${m.o.name} ${day(m.o.aim)}`).join(", ")}`}>
      <rect x={LABEL} y={12} width={x(cutDay) - LABEL} height={marks.length * rowH + 4} className="fill-slate-800" />
      <text x={LABEL} y={9} className="fill-slate-500 text-[8px]">
        no event under {L.limits.minDaysBeforeEvent} days (Fair Workweek)
      </text>
      {marks.map(({ o, now }, i) => {
        const y = 20 + i * rowH;
        return (
          <g key={o.id}>
            <text x={0} y={y + 3} className={`text-[9px] ${now ? "fill-slate-100" : "fill-slate-400"}`}>
              {o.name.length > 26 ? `${o.name.slice(0, 25)}…` : o.name}
            </text>
            <line x1={LABEL} x2={W - 8} y1={y} y2={y} className="stroke-slate-700" />
            <path d={`M ${x(o.aim)} ${y - 4} l 4 4 l -4 4 l -4 -4 z`} className={now ? "fill-slate-100" : "fill-slate-900 stroke-slate-400"} />
            <text x={Math.min(x(o.aim) + 7, W - 40)} y={y + 3} className="fill-slate-500 text-[8px]">
              {day(o.aim)}
            </text>
          </g>
        );
      })}
      <text x={LABEL} y={Ht - 2} className="fill-slate-600 text-[7px]">
        today
      </text>
      <text x={W - 8} y={Ht - 2} textAnchor="end" className="fill-slate-600 text-[7px]">
        +{span} days
      </text>
    </svg>
  );
}

export function TypeBody(p: PanelBits & { t: TypeFact }) {
  const { L, t, go } = p;
  const [metric, setMetric] = useState<Metric>("reply");
  const test = L.tests.find((x) => x.tier === t.tier && x.factor === "approach");
  const rows = t.arms.map((a) => ({ label: approachName(L, a.approachId), a }));
  return (
    <div className="text-sm text-slate-300">
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[1] === `type:${t.key}`)} />
      <p className="font-semibold text-slate-100">
        {t.label} <span className="font-normal text-slate-500">· {TIER_WORD[t.tier]}</span> <SyntheticTag what={L.synthetic} />
      </p>
      <p className="text-xs text-slate-400">
        {t.emailsThisWeek} emails this week · {t.ready} people ready ·{" "}
        <button type="button" onClick={() => go({ panel: "emails", tab: `t:${t.key}` })} className="underline-offset-2 hover:underline">
          read them
        </button>
      </p>
      <H>Occasions</H>
      <Timeline L={L} t={t} />
      {t.target ? (
        <p className="text-xs text-slate-400">
          Aimed at {t.target.name} on {day(t.target.aim)}: {t.target.basis}.
        </p>
      ) : null}
      <H>Their slice of the test</H>
      <p className="mb-1 text-xs text-slate-400">
        {test ? (
          <>
            They take part in{" "}
            <button type="button" onClick={() => go({ panel: `test:${test.id}` })} className="underline-offset-2 hover:underline">
              {test.question.toLowerCase().replace(/\?$/, "")}
            </button>
            . {t.emailsThisWeek} a week is too few to settle anything for this type alone, so this is a read, not a verdict. It shows if they answer differently from everyone else.
          </>
        ) : null}
      </p>
      <MetricTabs metric={metric} set={setMetric} />
      <Forest rows={rows} metric={metric} />
      <H>Held back</H>
      {t.held.length ? (
        <ul className="space-y-0.5 text-xs">
          {t.held.map((h) => (
            <li key={h.reason}>
              <span className="tabular-nums text-slate-200">{h.n}</span> <span className="text-slate-400">{h.reason}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-slate-500">Nobody held back this week.</p>
      )}
      {t.adjusted.length ? (
        <>
          <H>Emailed with a different ask</H>
          <ul className="space-y-0.5 text-xs">
            {t.adjusted.map((h) => (
              <li key={h.reason}>
                <span className="tabular-nums text-slate-200">{h.n}</span> <span className="text-slate-400">{h.reason}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function ApproachBody(p: PanelBits & { id: string }) {
  const { L, id, go } = p;
  const a = L.approaches[id];
  const [metric, setMetric] = useState<Metric>("reply");
  const inTests = L.tests.flatMap((t) => t.arms.filter((x) => x.approachId === id).map((x) => ({ label: t.tier === "cold" ? "New to us" : "Past customers", a: x })));
  const byType = L.types.flatMap((t) => t.arms.filter((x) => x.approachId === id).map((x) => ({ label: t.label, a: x })));
  const history = L.runs.flatMap((r) => r.decisions.filter((d) => d.approachId === id).map((d) => ({ week: r.weekStart, d })));
  const hist = L.history.find((h) => h.id === id);
  const samples = useMemo(() => {
    const seen = new Set<string>();
    return L.drafts.filter((d) => d.approachId === id && !seen.has(d.type) && seen.add(d.type)).slice(0, 3);
  }, [L.drafts, id]);
  if (!a) return <p className="text-xs text-slate-400">No approach {id}.</p>;
  return (
    <div className="text-sm text-slate-300">
      <p className="font-semibold text-slate-100">
        {a.name} {a.baseline ? <span className="font-normal text-slate-500">· a baseline</span> : null} <SyntheticTag what={L.synthetic} />
      </p>
      <p className="text-xs text-slate-500">
        {a.origin === "loop" ? "The loop's own idea" : a.origin === "research" ? "From your research list" : "Sent by hand before the loop"} · {a.createdBy}, {dateEt(a.createdAt)}
      </p>
      <p className="mt-1 text-xs text-slate-300">{a.brief}</p>
      {a.approvedAt === undefined ? null : a.approvedAt ? (
        <p className="mt-1 text-xs text-slate-500">
          Approved {dateEt(a.approvedAt)}
          {a.approvedBy ? ` by ${a.approvedBy}` : ""}.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-amber-500/60 p-2 text-xs">
          <span className="flex-1 text-slate-200">
            Waiting for your approval: {L.drafts.filter((d) => d.waitingApproval && d.approachId === id).length} emails hold until you approve it. Read the samples below first.
          </span>
          {p.Proto({ label: "Approve…", primary: true, onClick: () => go({ ...p.nav, modal: `approve:${id}` }) })}
        </div>
      )}
      <H>What it is for</H>
      {a.purpose ? <p.Row k="Meant to">{a.purpose}</p.Row> : null}
      {a.whyTried ? <p.Row k="Why try it">{a.whyTried}</p.Row> : null}
      {a.fitsWith ? <p.Row k="Whole email">{a.fitsWith}</p.Row> : null}
      {a.stopIf ? <p.Row k="Stop it if">{a.stopIf}</p.Row> : null}
      {a.slots.length ? <p.Row k="Lands">only {a.slots.map((s) => L.slots[s]?.label.toLowerCase() ?? s).join(", ")}</p.Row> : null}
      <H>Evidence</H>
      <Evidence list={a.evidence} />
      {hist ? (
        <p className="mt-1 text-xs text-slate-400">
          Before the loop: {hist.sent?.toLocaleString() ?? "?"} sent, {hist.replied ?? "?"} replies, {hist.deals ?? "?"} leads, {hist.booked ?? "?"} booked. <SyntheticTag what={hist.synthetic} />
        </p>
      ) : null}
      <H>How it is doing</H>
      <MetricTabs metric={metric} set={setMetric} />
      {inTests.length ? <Forest rows={inTests} metric={metric} /> : <p className="text-xs text-slate-500">Not in a test.</p>}
      <ShowNumbers label="By customer type">
        {byType.map((r) => (
          <div key={r.label}>
            {r.label}: replies {rateLine(r.a.reply)} · leads {rateLine(r.a.lead)}
          </div>
        ))}
      </ShowNumbers>
      <H>History</H>
      <ul className="space-y-1">
        {history.map((h, i) => (
          <li key={i} className="text-xs">
            <span className="text-slate-500">Week of {day(h.week)} · </span>
            <DecisionLine L={L} d={h.d} />
          </li>
        ))}
        {a.baseline ? <li className="text-xs text-slate-400">A baseline is never retired; it is what every new approach has to beat.</li> : null}
      </ul>
      <H>Sample emails</H>
      <ul className="space-y-1">
        {samples.map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => go({ panel: "emails", sel: `email:${d.id}`, tab: `a:${id}` })} className="text-left text-xs text-slate-300 underline-offset-2 hover:underline">
              “{d.subject}” <span className="text-slate-500">to {d.person.name}, {typeLabel(d.type).toLowerCase()}</span>
            </button>
          </li>
        ))}
        {samples.length ? null : <li className="text-xs text-slate-500">None this week.</li>}
      </ul>
    </div>
  );
}

export function HistoryBody(p: PanelBits) {
  const { L, go } = p;
  const max = Math.max(1, ...L.history.map((h) => h.sent ?? 0));
  return (
    <div className="text-sm text-slate-300">
      <p className="font-semibold text-slate-100">What we sent by hand</p>
      <p className="text-xs text-slate-400">
        Every email people sent before the loop is its starting data. The baselines carry these counts, so a new approach is measured against months of real replies, not a blank page. Counts since 1 August, from the
        sales numbers.
      </p>
      <ul className="mt-2 space-y-2">
        {L.history.map((h) => (
          <li key={h.id} className="border-t border-slate-800 pt-1.5 text-xs">
            <p className="flex items-baseline justify-between gap-2">
              {L.approaches[h.id] ? (
                <button type="button" onClick={() => go({ panel: `approach:${h.id}` })} className="font-semibold text-slate-100 underline-offset-2 hover:underline">
                  {h.name}
                </button>
              ) : (
                <span className="font-semibold text-slate-300">{h.name}</span>
              )}
              <span className="text-slate-500">{h.status}</span>
            </p>
            <div className="mt-1 flex items-center gap-2">
              <svg width={140} height={8} aria-hidden>
                <rect width={140} height={8} className="fill-slate-800" />
                <rect width={(140 * (h.sent ?? 0)) / max} height={8} className={h.status === "retired" ? "fill-slate-600" : "fill-slate-400"} />
              </svg>
              <span className="tabular-nums text-slate-300">
                {h.sent === null ? "no data" : `${h.sent.toLocaleString()} sent · ${h.replied ?? "?"} replies · ${h.deals ?? "?"} leads · ${h.booked ?? "?"} booked`}
              </span>
            </div>
            <p className="mt-0.5 text-slate-400">{h.becomes}</p>
            <SyntheticTag what={h.synthetic} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LimitsBody(p: PanelBits) {
  const { L } = p;
  const m = L.limits;
  if (L.limitsRecorded === false)
    return (
      <div className="text-sm text-slate-300">
        <p className="font-semibold text-slate-100">Your limits</p>
        <p className="mt-1 text-xs text-slate-400">
          This week&apos;s run started before runs recorded the limits they ran under. From next Monday&apos;s run on, this shows exactly what the loop ran under. The limits themselves live in sales/loop/limits.toml in Catering-Manager, and a change is a PR that quotes your words.
        </p>
      </div>
    );
  return (
    <div className="text-sm text-slate-300">
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[1] === "limits")} />
      <p className="font-semibold text-slate-100">
        Your limits <SyntheticTag what={L.synthetic} />
      </p>
      <p className="text-xs text-slate-400">
        What this week&apos;s run ran under. Two kinds: hard lines the loop never crosses, and suggestions it may go past when it has a reason, saying why in the memo. A change to either is a PR that quotes your words.
      </p>
      <H>Sending</H>
      <p.Row k="Every day">at most {m.dailyCap} loop emails across every mailbox, and no mailbox past its own allowance</p.Row>
      <p.Row k="Cold">{m.coldEnabled ? "on, from the cold mailboxes through Apollo" : "off until you say go"}</p.Row>
      <p.Row k="Baseline">{Math.round(m.baselineShare * 100)}% of each test goes to the email we sent by hand</p.Row>
      <p.Row k="Approaches">at most {m.maxLive} live per customer type (fewer settles faster)</p.Row>
      <p.Row k="Apollo">{m.apolloCredits ? `${m.apolloCredits} credits a week` : "no credits to spend"}</p.Row>
      <p.Row k="Pause">every loop email stops if unsubscribes pass {Math.round(m.unsubPause * 100)}% in 7 days</p.Row>
      <H>Never</H>
      <ul className="list-disc space-y-0.5 pl-4 text-xs">
        {m.never.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <H>Suggestions</H>
      <ul className="list-disc space-y-0.5 pl-4 text-xs">
        {m.leanToward.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <H>Who</H>
      <p.Row k="Everyone">emailed whatever their past headcount; the cake option comes only in your reply draft</p.Row>
      <p.Row k="Lost deals">held back {m.holdBackMonths} months</p.Row>
      <p.Row k="Events">none under {m.minDaysBeforeEvent} days away (Fair Workweek)</p.Row>
      <p.Row k="Never email">{m.neverEmail ? `${m.neverEmail} addresses and domains` : "nobody listed"}</p.Row>
      <H>Offers and occasions</H>
      <p.Row k="Offers">{m.allowedOffers.length ? `${m.allowedOffers.join("; ")}. Anything else waits for you.` : "none without asking you"}</p.Row>
      <p.Row k="Occasions">{m.approvedAsk.length ? m.approvedAsk.join(", ") : "only those rated a good fit; none of the 'ask' ones approved yet"}</p.Row>
      <H>Research</H>
      <p.Row k="LinkedIn">
        {m.linkedinCap} company pages a day, {m.linkedinPause}s apart, on Alex&apos;s account, read only
      </p.Row>
    </div>
  );
}

export function ResearchBody(p: PanelBits) {
  const { L } = p;
  const R = L.research;
  const maxOff = Math.max(10, ...R.accuracy.map((a) => a.medianDaysOff ?? 0));
  return (
    <div className="text-sm text-slate-300">
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[1] === "research")} />
      <p className="font-semibold text-slate-100">
        Research <SyntheticTag what={L.synthetic} />
      </p>
      <p.Row k="LinkedIn today">
        <span className="flex items-center gap-2">
          <Bullet value={R.viewsToday} target={L.limits.linkedinCap} width={100} /> {R.viewsToday} of {L.limits.linkedinCap} pages
        </span>
      </p.Row>
      {R.halt ? (
        <div className="mt-2 rounded border border-red-500/60 p-2 text-xs">
          <p className="font-semibold text-red-300">
            <Glyph mark="warning" /> Halted {dateEt(R.halt.at)} {timeEt(R.halt.at)}
          </p>
          <p className="mt-1 text-slate-200">{R.halt.note}</p>
          <p className="mt-1 text-slate-400">The loop never signs in or works around a warning. Alex checks the account, then resumes.</p>
          <div className="mt-1.5">{p.Proto({ label: "Resume research" })}</div>
        </div>
      ) : null}
      <H>Event dates found</H>
      {R.estimates.length ? null : <p className="text-xs text-slate-500">None found yet.</p>}
      <ul className="space-y-1.5">
        {R.estimates.map((e) => (
          <li key={`${e.company}${e.date}`} className="border-t border-slate-800 pt-1 text-xs">
            <p className="text-slate-200">
              {e.company} · {e.kind} · {day(e.date)}
            </p>
            <p className="text-slate-400">
              {SOURCE_WORD[e.source]}, {pct(e.confidence)} sure · “{e.evidence}”{" "}
              <a href={e.evidenceUrl} target="_blank" rel="noreferrer" className="text-slate-500 underline">
                source
              </a>
            </p>
          </li>
        ))}
      </ul>
      <H>How far off each source has been</H>
      <div className="space-y-1">
        {R.accuracy.map((a) => (
          <div key={a.source} className="grid grid-cols-[90px_120px_1fr] items-center gap-2 text-xs">
            <span className="text-slate-300">{SOURCE_WORD[a.source] ?? a.source}</span>
            <svg width={120} height={8} aria-hidden>
              <rect width={120} height={8} className="fill-slate-800" />
              <rect width={(120 * (a.medianDaysOff ?? 0)) / maxOff} height={8} className="fill-slate-400" />
            </svg>
            <span className="text-slate-400">{a.checked ? `${a.medianDaysOff} days typical · ${a.checked} checked against a booking` : "nothing to check yet"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function NotesBody(p: PanelBits) {
  const { L } = p;
  return (
    <div className="text-sm text-slate-300">
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[1] === "notes")} />
      <p className="font-semibold text-slate-100">
        Personal notes <SyntheticTag what={L.synthetic} />
      </p>
      <p className="text-xs text-slate-400">People with a complaint or a refund. The loop never emails them; they hear from you.</p>
      {L.notes.length ? null : <p className="mt-2 text-xs text-slate-500">Nobody waiting for a note.</p>}
      <ul className="mt-2 space-y-2">
        {L.notes.map((n) => (
          <li key={n.name} className="border-t border-slate-800 pt-1.5 text-xs">
            <p className="text-slate-200">
              {n.name} · {n.company}
            </p>
            <p className="text-slate-400">{n.why}</p>
            <p className="text-slate-500">{n.noteSentAt ? `Your note went ${dateEt(n.noteSentAt)}.` : `Waiting since ${dateEt(n.since)}.`}</p>
            {n.noteSentAt ? null : <div className="mt-1 flex gap-2">{p.Proto({ label: "Mark note sent" })}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The loop's bullet row in "This week": against the 4-week average. */
export function LoopWeekBars({ L, onOpen }: { L: LoopFacts; onOpen: () => void }) {
  const bars: [keyof LoopFacts["week"]["avg4"], string][] = [
    ["replies", "Replies"],
    ["leads", "Leads"],
    ["bookings", "Bookings"],
  ];
  return (
    <button type="button" onClick={onOpen} className="flex flex-wrap items-center gap-x-3 rounded px-1 py-0.5 text-xs text-slate-300 hover:bg-slate-900">
      <span className="text-slate-500">Loop</span>
      {bars.map(([k, label]) => (
        <span key={k} className="flex items-center gap-1">
          <span className="text-slate-400">{label}</span>
          <Bullet value={L.week[k]} target={L.week.avg4[k]} width={50} />
          <span className="tabular-nums">{L.week[k]}</span>
        </span>
      ))}
      <SyntheticTag what={L.synthetic} />
    </button>
  );
}

export type { Rollup };
