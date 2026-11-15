"use client";

// PROTOTYPE (bj-finance #811 round 3, #964), throwaway. The weekly email
// loop on the one-screen console: the loop region (spec 10.2), its chart,
// and the panels of spec 10.3. Gray at rest; colour only through badges.
// Every action button is a prototype and does nothing.

import { useMemo, useState, type ReactNode } from "react";
import type { AttentionItem } from "@/lib/emailCampaignsPrototype/console/attention";
import { rollup } from "@/lib/emailCampaignsPrototype/console/attention";
import {
  MIN_SENDS_FOR_VERDICT,
  SOURCE_WORD,
  TIER_WORD,
  VERDICT_WORD,
  typeLabel,
  type ArmFact,
  type DraftFact,
  type LoopFacts,
  type RateFact,
  type TypeFact,
} from "@/lib/emailCampaignsPrototype/console/loop";
import { dateEt, dowEt, timeEt } from "@/lib/emailCampaignsPrototype/console/time";
import { Badge, Bullet, Glyph, SyntheticTag } from "./bits";

export type LoopNav = { panel?: string; sel?: string; layer?: string; modal?: string; tab?: string; dim?: string };
type Go = (n: LoopNav) => void;

const day = (ymd: string) => dateEt(`${ymd}T17:00:00Z`);
const dow = (ymd: string) => dowEt(`${ymd}T17:00:00Z`);
const pct = (x: number | null) => (x === null ? "?" : `${Math.round(x * 100)}%`);
const r1 = (x: number | null) => (x === null ? "?" : x >= 10 ? x.toFixed(0) : x.toFixed(1));
const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();
const daysUntil = (from: string, to: string) => Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000);

export function approachName(L: LoopFacts, id: string) {
  return L.approaches[id]?.name ?? id;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/** One shared scale for every type row, so rows compare by eye. */
export function loopScale(L: LoopFacts): number {
  // Points, and ranges only where there are enough emails to judge: a
  // 12-email range would squash every other row. Longer lines are clipped.
  const live = L.types.flatMap((t) => t.arms.filter((a) => a.status !== "retired"));
  const vals = live.flatMap((a) => [a.lead.per1000 ?? 0, a.sends >= MIN_SENDS_FOR_VERDICT ? (a.lead.hi ?? 0) : 0]);
  return Math.ceil(Math.max(30, ...vals) / 10) * 10;
}

/** The type row's strip: one dot per live approach at its leads per 1,000,
 * a line for the 90% range, stacked so they never overlap. Hollow dot for
 * the baseline, gray under 150 sends. */
export function ArmStrip({ arms, max, L, width = 220 }: { arms: ArmFact[]; max: number; L: LoopFacts; width?: number }) {
  const live = arms.filter((a) => a.status !== "retired");
  const h = Math.max(16, live.length * 7 + 4);
  const x = (v: number | null) => 4 + (Math.min(v ?? 0, max) / max) * (width - 8);
  return (
    <svg width={width} height={h} role="img" aria-label={live.map((a) => `${approachName(L, a.approachId)} ${r1(a.lead.per1000)} leads per 1,000`).join("; ")}>
      <line x1={4} x2={width - 4} y1={h - 1} y2={h - 1} className="stroke-slate-800" />
      {live.map((a, i) => {
        const y = 4 + i * 7;
        const early = a.sends < MIN_SENDS_FOR_VERDICT;
        const base = L.approaches[a.approachId]?.baseline;
        return (
          <g key={a.approachId}>
            <title>{`${approachName(L, a.approachId)}: ${a.lead.k} leads in ${a.lead.n} emails, ${r1(a.lead.per1000)} per 1,000 (range ${r1(a.lead.lo)} to ${r1(a.lead.hi)})${early ? ", too early" : ""}`}</title>
            <line x1={x(a.lead.lo)} x2={x(a.lead.hi)} y1={y} y2={y} className={early ? "stroke-slate-700" : "stroke-slate-500"} strokeWidth={1.5} />
            {(a.lead.hi ?? 0) > max ? <path d={`M ${width - 4} ${y - 2} l 3 2 l -3 2`} className="fill-slate-600" /> : null}
            <circle
              cx={x(a.lead.per1000)}
              cy={y}
              r={3}
              className={base ? "fill-slate-950 stroke-slate-300" : early ? "fill-slate-600" : "fill-slate-200"}
              strokeWidth={base ? 1.2 : 0}
            />
          </g>
        );
      })}
    </svg>
  );
}

type Metric = "reply" | "lead" | "booking";
const METRIC_WORD: Record<Metric, string> = { reply: "Replies", lead: "Leads", booking: "Bookings" };

/** The panel chart: one row per approach, the rate and its range, with the
 * chance of being best as a bar beside it. */
function Forest({ rows, L, metric }: { rows: { label: string; a: ArmFact }[]; L: LoopFacts; metric: Metric }) {
  // Same rule as the row strip: early ranges do not set the scale; clipped.
  const max = Math.max(10, ...rows.flatMap((r) => [(r.a[metric].per1000 ?? 0) * 1.5, r.a.sends >= MIN_SENDS_FOR_VERDICT ? (r.a[metric].hi ?? 0) : 0]));
  const scale = Math.ceil(max / 10) * 10;
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
        const early = a.sends < MIN_SENDS_FOR_VERDICT;
        const base = L.approaches[a.approachId]?.baseline;
        return (
          <div key={label} className={`grid grid-cols-[110px_200px_1fr] items-center gap-2 text-xs ${a.status === "retired" ? "opacity-50" : ""}`}>
            <span className="truncate text-slate-300" title={label}>
              {label}
            </span>
            <svg width={W} height={14} role="img" aria-label={`${label}: ${r.k} of ${r.n}, ${r1(r.per1000)} per 1,000, range ${r1(r.lo)} to ${r1(r.hi)}`}>
              <line x1={2} x2={W - 2} y1={7} y2={7} className="stroke-slate-800" />
              <line x1={x(r.lo)} x2={x(r.hi)} y1={7} y2={7} className={early ? "stroke-slate-600" : "stroke-slate-400"} strokeWidth={2} />
              {(r.hi ?? 0) > scale ? <path d={`M ${W - 5} 4 l 4 3 l -4 3`} className="fill-slate-500" /> : null}
              <circle cx={x(r.per1000)} cy={7} r={3.5} className={base ? "fill-slate-900 stroke-slate-200" : early ? "fill-slate-500" : "fill-slate-100"} strokeWidth={base ? 1.4 : 0} />
            </svg>
            <span className="flex items-center gap-1">
              <svg width={60} height={8} aria-hidden>
                <rect width={60} height={8} className="fill-slate-800" />
                <rect width={60 * (a.best ?? 0)} height={8} className="fill-slate-400" />
              </svg>
              <span className="tabular-nums text-slate-400">{a.status === "retired" ? "retired" : pct(a.best)}</span>
            </span>
          </div>
        );
      })}
      <p className="text-[10px] text-slate-600">dot = rate · line = 90% range · hollow = baseline · gray = under {MIN_SENDS_FOR_VERDICT} emails (too early)</p>
    </div>
  );
}

function ShowNumbers({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-[11px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline">
        {open ? "Hide numbers" : "Show numbers"}
      </button>
      {open ? <div className="mt-1 space-y-0.5 text-[11px] tabular-nums text-slate-400">{children}</div> : null}
    </div>
  );
}

const rateLine = (r: RateFact) => `${r.k} of ${r.n} · ${r1(r.per1000)} per 1,000 (${r1(r.lo)} to ${r1(r.hi)})`;

// ---------------------------------------------------------------------------
// The header line and the loop region
// ---------------------------------------------------------------------------

export function LoopWeekLine({ L, items, go }: { L: LoopFacts; items: AttentionItem[]; go: Go }) {
  const week = rollup(items, ["loop", "week"]);
  const sentToday = L.drafts.filter((d) => d.sendOn === L.today && d.status === "sent").length;
  const dueToday = L.drafts.filter((d) => d.sendOn === L.today).length;
  const runPhrase = L.run
    ? L.run.check.ok
      ? `Weekly run ${dowEt(L.run.createdAt)}, ${timeEt(L.run.createdAt)}`
      : "Weekly run stopped at its check"
    : `No weekly run for the week of ${day(L.weekStart)}`;
  const firstSend = L.drafts.map((d) => d.sendOn).sort()[0];
  return (
    <div className="space-y-0.5 text-xs text-slate-500">
      <p>
        <button type="button" onClick={() => go({ panel: "week" })} className={`hover:text-slate-200 ${week.level === "warning" ? "font-semibold text-red-400" : ""}`}>
          {runPhrase}
        </button>
        {L.run ? (
          <>
            {" · "}
            <button type="button" onClick={() => go({ panel: "emails" })} className="hover:text-slate-200">
              {L.run.planned} emails this week
            </button>
            {" · "}
            {L.paused ? (
              <span className="text-slate-400">loop paused</span>
            ) : dueToday ? (
              `${sentToday} of ${dueToday} sent today`
            ) : firstSend && firstSend > L.today ? (
              `first sends ${dow(firstSend)}`
            ) : (
              "none due today"
            )}
            {L.gate && !L.run.approvedAt ? <span className="text-slate-400"> · waiting for your approval</span> : null}
          </>
        ) : null}
        <SyntheticTag what={L.synthetic} />
      </p>
      {L.run?.check.ok ? (
        <p className="flex min-w-0 items-baseline gap-1">
          <span className="shrink-0 text-slate-600">Week of {day(L.weekStart)} ·</span>
          <button type="button" onClick={() => go({ panel: "week" })} className="min-w-0 truncate text-left text-slate-400 hover:text-slate-200" title={L.run.memo}>
            “{firstSentence(L.run.memo)}”
          </button>
        </p>
      ) : null}
    </div>
  );
}

export function LoopRegion({ L, items, go, fade, lanes }: { L: LoopFacts; items: AttentionItem[]; go: Go; fade: (has: boolean) => string; lanes: ReactNode }) {
  const loopR = rollup(items, ["loop"]);
  const max = loopScale(L);
  const byTier = (["warm", "offer"] as const).map((t) => ({ t, rows: L.types.filter((x) => x.tier === t) })).filter((g) => g.rows.length);
  const leader = (t: TypeFact) => {
    const live = t.arms.filter((a) => a.status === "live" && a.best !== null).sort((a, b) => (b.best ?? 0) - (a.best ?? 0));
    const top = live[0];
    if (!top) return "too early";
    const most = Math.max(...t.arms.filter((a) => a.status === "live").map((a) => a.sends));
    if (most < MIN_SENDS_FOR_VERDICT) return `too early · ${most} of ${MIN_SENDS_FOR_VERDICT}`;
    return `${approachName(L, top.approachId)} · ${pct(top.best)} best`;
  };
  return (
    <section aria-label="The loop" className="mt-3">
      <div className="grid grid-cols-[1fr_auto] items-baseline gap-2 text-[11px] uppercase tracking-wide text-slate-500 sm:grid-cols-[minmax(0,190px)_minmax(0,1fr)_84px_220px_minmax(0,170px)]">
        <span className="flex items-center gap-2">
          The loop <Badge r={loopR} label="The loop" />
        </span>
        <span className="hidden sm:block">aimed at</span>
        <span className="text-right">this week</span>
        <span className="hidden normal-case sm:flex sm:justify-between">
          <span>leads per 1,000</span>
          <span>{max}</span>
        </span>
        <span className="hidden normal-case sm:block">ahead</span>
      </div>
      {byTier.map(({ t, rows }) => (
        <div key={t} className="border-t border-slate-800 pt-1">
          <p className="text-[11px] text-slate-500">{TIER_WORD[t]}</p>
          {rows.map((x) => {
            const r = rollup(items, ["loop", `type:${x.key}`]);
            return (
              <button
                key={x.key}
                type="button"
                onClick={() => go({ panel: `type:${x.key}` })}
                className={`grid w-full grid-cols-[1fr_auto] items-center gap-2 rounded py-0.5 text-left text-sm hover:bg-slate-900 sm:grid-cols-[minmax(0,190px)_minmax(0,1fr)_84px_220px_minmax(0,170px)] ${fade(r.count > 0)}`}
              >
                <span className="flex items-center gap-1.5 truncate pl-2 text-slate-100">
                  {x.label} <Badge r={r} label={x.label} />
                </span>
                <span className="hidden truncate text-xs text-slate-400 sm:block">
                  {x.target ? `${x.target.name} · ${day(x.target.aim)}` : <span className="text-slate-600">no occasion this week</span>}
                </span>
                <span className="text-right text-xs tabular-nums text-slate-300">
                  {x.emailsThisWeek} <span className="text-slate-500">emails</span>
                </span>
                <span className="hidden sm:block">
                  <ArmStrip arms={x.arms} max={max} L={L} />
                </span>
                <span className="hidden truncate text-xs text-slate-500 sm:block">{leader(x)}</span>
              </button>
            );
          })}
        </div>
      ))}
      <div className="border-t border-slate-800 py-1 text-sm text-slate-400">
        <button type="button" onClick={() => go({ panel: "limits" })} className="flex items-center gap-2 hover:text-slate-200">
          <Glyph mark="off" /> <span className="text-slate-300">Cold</span>
          <span className="text-xs">{L.cold.enabled ? "on" : `off · ${L.cold.ready.toLocaleString()} prospects wait for your go`}</span>
        </button>
      </div>
      <div className="border-t border-slate-800 py-1 text-xs text-slate-400">
        <button type="button" onClick={() => go({ panel: "week", sel: "volume" })} className="flex flex-wrap items-center gap-2 hover:text-slate-200">
          <span>
            {L.volume.ready.toLocaleString()} people ready · room for {L.volume.roomPerWeek} a week
          </span>
          <Bullet value={L.volume.roomPerWeek} target={L.volume.ready} width={120} />
          {L.volume.ready > L.volume.roomPerWeek * 1.1 ? <span className="text-slate-500">volume is the limit: more mailboxes or a higher daily cap</span> : null}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <button type="button" onClick={() => go({ panel: "emails" })} className="hover:text-slate-300">
          Emails this week
        </button>
        <button type="button" onClick={() => go({ panel: "limits" })} className="hover:text-slate-300">
          Your limits
        </button>
        <button type="button" onClick={() => go({ panel: "research" })} className="flex items-center gap-1 hover:text-slate-300">
          Research <Badge r={rollup(items, ["loop", "research"])} label="Research" />
        </button>
        <button type="button" onClick={() => go({ panel: "notes" })} className="flex items-center gap-1 hover:text-slate-300">
          Personal notes {L.notes.filter((n) => !n.noteSentAt).length || ""} <Badge r={rollup(items, ["loop", "notes"])} label="Personal notes" />
        </button>
      </div>
      <div className="mt-3">{lanes}</div>
      <p className="mt-1 text-[10px] text-slate-600">The loop takes over the Warm and Cold rows when it goes live; Offer and Wedding stay hand-run until it takes each over.</p>
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
  Row: (p: { k: string; children: ReactNode }) => ReactNode;
  Alerts: (p: { items: AttentionItem[] }) => ReactNode;
};

const H = ({ children }: { children: ReactNode }) => <p className="mb-1 mt-3 text-[11px] uppercase tracking-wide text-slate-500">{children}</p>;

function DecisionLine({ L, d }: { L: LoopFacts; d: LoopFacts["runs"][number]["decisions"][number] }) {
  const verb = { add: "Started", retire: "Retired", crown: "Crowned", reopen: "Reopened", hold: "Kept" }[d.kind];
  return (
    <span className="text-xs text-slate-300">
      <span className="font-semibold text-slate-100">
        {verb} “{approachName(L, d.approachId)}”
      </span>
      {d.type ? ` for ${typeLabel(d.type).toLowerCase()}` : " for every type"}. <span className="text-slate-400">{d.reason}</span>
    </span>
  );
}

export function WeekBody(p: PanelBits) {
  const { L, go } = p;
  const run = L.run;
  return (
    <div className="text-sm text-slate-300">
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[1] === "week")} />
      <p className="font-semibold text-slate-100">
        Week of {day(L.weekStart)} <SyntheticTag what={L.synthetic} />
      </p>
      {run ? (
        <>
          <p.Row k="Run">{`${dowEt(run.createdAt)} at ${timeEt(run.createdAt)}`}</p.Row>
          <p.Row k="Check">
            {run.check.ok ? null : <Glyph mark="warning" />} {run.check.text}
          </p.Row>
          <p.Row k="Planned">
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => go({ panel: "emails" })}>
              {run.planned} emails
            </button>
          </p.Row>
          <p.Row k="Digest">{run.digestSentAt ? `emailed to you ${timeEt(run.digestSentAt)}` : "not sent"}</p.Row>
          {L.gate ? <p.Row k="Approval">{run.approvedAt ? `approved ${dateEt(run.approvedAt)}` : "waiting for you: nothing sends until you approve"}</p.Row> : null}
          <H>Memo</H>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-200">{run.memo}</p>
          {run.asks.length ? (
            <>
              <H>Asks you</H>
              <ul className="space-y-2">
                {run.asks.map((a) => (
                  <li key={a.id} className="rounded border border-slate-700 p-2 text-xs">
                    <p className="text-slate-200">{a.text}</p>
                    <div className="mt-1.5 flex gap-2">
                      {p.Proto({ label: "Yes" })}
                      {p.Proto({ label: "Not now" })}
                      {p.Proto({ label: "Answer in words…" })}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <H>Decided</H>
          <ul className="space-y-1">
            {run.decisions.map((d, i) => (
              <li key={i}>
                <DecisionLine L={L} d={d} />
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            {L.gate && !run.approvedAt ? p.Proto({ label: "Read and approve the week", primary: true, onClick: () => go({ panel: "emails" }) }) : null}
            {p.Proto({ label: L.paused ? "Resume the loop…" : "Pause the loop…", onClick: () => go({ ...p.nav, modal: "pause" }) })}
          </div>
        </>
      ) : (
        <p className="mt-1 text-xs text-slate-400">No run logged for this week. The run plans the week on Monday morning; until it does, nothing new sends.</p>
      )}
      <H>Volume</H>
      <p className="text-xs">
        {L.volume.ready.toLocaleString()} people are ready for an email. The mailboxes have room for {L.volume.roomPerWeek} a week ({L.limits.dailyCap} a day under your cap). Raising the cap or adding a
        mailbox is the fix; copy is not the limit.
      </p>
      <Bullet value={L.volume.roomPerWeek} target={L.volume.ready} width={240} />
      <H>Earlier weeks</H>
      <ul className="space-y-2">
        {L.runs
          .filter((r) => r !== run)
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

export function EmailsBody(p: PanelBits) {
  const { L, nav, go } = p;
  const [type, setType] = useState(nav.tab?.startsWith("t:") ? nav.tab.slice(2) : "");
  const [appr, setAppr] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const shown = L.drafts.filter((d) => (!type || d.type === type) && (!appr || d.approachId === appr));
  const days = [...new Set(shown.map((d) => d.sendOn))].sort();
  const sel = "rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-xs text-slate-200";
  return (
    <div className="text-sm text-slate-300">
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[1] === "emails" && !i.path[2])} />
      <p className="font-semibold text-slate-100">
        Emails this week <SyntheticTag what={L.synthetic} />
      </p>
      <p className="text-xs text-slate-400">Each one as it will arrive. Open one to read it in full and see why that person gets it.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <select aria-label="Customer type" value={type} onChange={(e) => setType(e.target.value)} className={sel}>
          <option value="">Every type</option>
          {L.types.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <select aria-label="Approach" value={appr} onChange={(e) => setAppr(e.target.value)} className={sel}>
          <option value="">Every approach</option>
          {Object.values(L.approaches).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="self-center text-xs text-slate-500">{shown.length} emails</span>
      </div>
      {L.gate && L.run && !L.run.approvedAt ? (
        <div className="mt-2 rounded border border-slate-700 p-2 text-xs">
          <p>Your approval is on for the first live weeks. Nothing below sends until you approve the week. Hold any single email first.</p>
          <div className="mt-1.5">{p.Proto({ label: `Approve all ${L.drafts.filter((d) => d.status === "planned").length} planned emails…`, primary: true, onClick: () => go({ ...nav, modal: "approve" }) })}</div>
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
                    className="grid w-full grid-cols-[14px_minmax(0,150px)_1fr] items-baseline gap-2 border-t border-slate-800 py-1 text-left text-xs hover:bg-slate-800/60"
                  >
                    <span className="text-slate-500">{x.status === "sent" ? "✓" : x.status === "held" ? "‖" : x.status === "skipped" ? "–" : ""}</span>
                    <span className="truncate text-slate-200">{x.person.name}</span>
                    <span className="truncate text-slate-400">
                      {x.subject} <span className="text-slate-600">· {x.touch} of {x.planned}</span>
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
    </div>
  );
}

export function EmailBody(p: PanelBits & { d: DraftFact }) {
  const { L, d, go, nav } = p;
  const t = L.types.find((x) => x.key === d.type);
  const away = daysUntil(d.sendOn, d.why.eventDate);
  if (nav.layer === "flag")
    return (
      <div className="text-sm text-slate-300">
        <p className="font-semibold text-slate-100">Flag this email</p>
        <p className="mt-1 text-xs text-slate-400">It is held now. Say what an email should never say, in your words. The loop opens a PR to your won&apos;t-say list that quotes you, and rewrites any email that breaks it.</p>
        <textarea rows={4} className="mt-2 w-full rounded border border-slate-700 bg-slate-950 p-2 text-xs text-slate-100" placeholder="Never say…" />
        <div className="mt-2 flex gap-2">
          {p.Proto({ label: "Add to won't say", primary: true, onClick: () => go({ ...nav, layer: undefined }) })}
          {p.Proto({ label: "Just hold it", onClick: () => go({ ...nav, layer: undefined }) })}
        </div>
      </div>
    );
  return (
    <div className="text-sm text-slate-300">
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[2] === d.id)} />
      <div className="rounded-md bg-white p-3 text-[13px] leading-relaxed text-slate-900 shadow">
        <div className="space-y-0.5 border-b border-slate-200 pb-2 text-xs text-slate-500">
          <p>
            <span className="inline-block w-12">From</span> {d.mailbox || "a news mailbox"}
          </p>
          <p>
            <span className="inline-block w-12">To</span> {d.person.name} &lt;{d.person.email}&gt;
          </p>
          <p>
            <span className="inline-block w-12">Sends</span> {dow(d.sendOn)}, 10am
          </p>
        </div>
        <p className="mt-2 font-semibold">{d.subject}</p>
        <p className="mt-2 whitespace-pre-wrap font-sans">{d.body}</p>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {d.status === "planned" ? p.Proto({ label: "Hold this email" }) : null}
        {d.status === "planned" ? p.Proto({ label: "Flag…", onClick: () => go({ ...nav, layer: "flag" }) }) : null}
        <span className="self-center text-xs text-slate-500">
          {d.status === "sent" ? "Sent." : d.status === "held" ? "Held." : d.status === "skipped" ? `Skipped: ${d.skipReason}` : "Planned."}
        </span>
      </div>
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
      <p.Row k="Approach">
        <button type="button" onClick={() => go({ panel: `approach:${d.approachId}` })} className="underline-offset-2 hover:underline">
          {approachName(L, d.approachId)}
        </button>
        <span className="text-slate-400">
          {" "}
          · picked by {d.assignedBy === "baseline_quota" ? `the baseline's ${Math.round(L.limits.baselineShare * 100)}% share` : "the daily draw (better approaches get more)"}
        </span>
      </p.Row>
      <p.Row k="Email">
        {d.touch} of {d.planned}
      </p.Row>
      <H>Already sent to them</H>
      {d.prior.length ? (
        <ul className="space-y-0.5 text-xs">
          {d.prior.map((x) => (
            <li key={x.touch}>
              {day(x.sentOn)} · “{x.subject}”
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-slate-500">Nothing from the loop yet. This is their first.</p>
      )}
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
  const H = 18 + marks.length * rowH + 12;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Occasions for ${t.label}: ${marks.map((m) => `${m.o.name} ${day(m.o.aim)}`).join(", ")}`}>
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
      <text x={LABEL} y={H - 2} className="fill-slate-600 text-[7px]">
        today
      </text>
      <text x={W - 8} y={H - 2} textAnchor="end" className="fill-slate-600 text-[7px]">
        +{span} days
      </text>
    </svg>
  );
}

export function TypeBody(p: PanelBits & { t: TypeFact }) {
  const { L, t, go } = p;
  const [metric, setMetric] = useState<Metric>("lead");
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
      <H>Approaches</H>
      <div className="mb-1 flex gap-1">
        {(Object.keys(METRIC_WORD) as Metric[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMetric(m)}
            className={`rounded border px-1.5 text-[11px] ${metric === m ? "border-slate-400 text-slate-100" : "border-slate-700 text-slate-500"}`}
          >
            {METRIC_WORD[m]}
          </button>
        ))}
      </div>
      <Forest rows={rows} L={L} metric={metric} />
      <ul className="mt-2 space-y-1">
        {t.arms.map((a) => (
          <li key={a.approachId} className="text-xs">
            <button type="button" onClick={() => go({ panel: `approach:${a.approachId}` })} className="font-semibold text-slate-200 underline-offset-2 hover:underline">
              {approachName(L, a.approachId)}
            </button>
            <span className="text-slate-400">
              {" "}
              · {a.status === "retired" ? `retired ${day(a.since.slice(0, 10))}` : VERDICT_WORD[a.verdict]} · {a.emailsThisWeek} this week
            </span>
            {a.status === "retired" ? <span className="block text-slate-500">{a.reason}</span> : null}
          </li>
        ))}
      </ul>
      <ShowNumbers>
        {t.arms.map((a) => (
          <div key={a.approachId}>
            <span className="text-slate-300">{approachName(L, a.approachId)}</span>: replies {rateLine(a.reply)} · leads {rateLine(a.lead)} · bookings {rateLine(a.booking)} · chance of best {pct(a.best)}
          </div>
        ))}
      </ShowNumbers>
      <H>Occasions</H>
      <Timeline L={L} t={t} />
      {t.target ? (
        <p className="text-xs text-slate-400">
          Aimed at {t.target.name} on {day(t.target.aim)}: {t.target.basis}.
        </p>
      ) : null}
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
    </div>
  );
}

export function ApproachBody(p: PanelBits & { id: string }) {
  const { L, id, go } = p;
  const a = L.approaches[id];
  const [metric, setMetric] = useState<Metric>("lead");
  const rows = L.types.flatMap((t) => t.arms.filter((x) => x.approachId === id).map((x) => ({ label: t.label, a: x })));
  const history = L.runs.flatMap((r) => r.decisions.filter((d) => d.approachId === id).map((d) => ({ week: r.weekStart, d })));
  const samples = useMemo(() => {
    const seen = new Set<string>();
    return L.drafts.filter((d) => d.approachId === id && !seen.has(d.type) && seen.add(d.type)).slice(0, 3);
  }, [L.drafts, id]);
  if (!a) return <p className="text-xs text-slate-400">No approach {id}.</p>;
  return (
    <div className="text-sm text-slate-300">
      <p className="font-semibold text-slate-100">
        {a.name} {a.baseline ? <span className="font-normal text-slate-500">· the baseline</span> : null} <SyntheticTag what={L.synthetic} />
      </p>
      <p className="mt-1 text-xs text-slate-300">{a.brief}</p>
      <p.Row k="Opener">{a.opener}</p.Row>
      <p.Row k="Shape">{a.structure}</p.Row>
      <p.Row k="Asks for">{a.ask}</p.Row>
      <p.Row k="Length">{a.length}</p.Row>
      <p.Row k="Written by">
        {a.createdBy}, {dateEt(a.createdAt)}
      </p.Row>
      <H>In each type</H>
      <div className="mb-1 flex gap-1">
        {(Object.keys(METRIC_WORD) as Metric[]).map((m) => (
          <button key={m} type="button" onClick={() => setMetric(m)} className={`rounded border px-1.5 text-[11px] ${metric === m ? "border-slate-400 text-slate-100" : "border-slate-700 text-slate-500"}`}>
            {METRIC_WORD[m]}
          </button>
        ))}
      </div>
      {rows.length ? <Forest rows={rows} L={L} metric={metric} /> : <p className="text-xs text-slate-500">Not live in any type.</p>}
      <ShowNumbers>
        {rows.map((r) => (
          <div key={r.label}>
            {r.label}: replies {rateLine(r.a.reply)} · leads {rateLine(r.a.lead)} · bookings {rateLine(r.a.booking)}
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
        {a.baseline ? <li className="text-xs text-slate-400">The baseline is never retired; it is what every new approach has to beat.</li> : null}
      </ul>
      <H>Sample emails</H>
      <ul className="space-y-1">
        {samples.map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => go({ panel: "emails", sel: `email:${d.id}` })} className="text-left text-xs text-slate-300 underline-offset-2 hover:underline">
              “{d.subject}” <span className="text-slate-500">to {d.person.name}, {typeLabel(d.type).toLowerCase()}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LimitsBody(p: PanelBits) {
  const { L } = p;
  const m = L.limits;
  return (
    <div className="text-sm text-slate-300">
      <p.Alerts items={p.items.filter((i) => i.path[0] === "loop" && i.path[1] === "limits")} />
      <p className="font-semibold text-slate-100">
        Your limits <SyntheticTag what={L.synthetic} />
      </p>
      <p className="text-xs text-slate-400">The loop reads these and never changes them. A change is a PR to limits.toml that quotes your words.</p>
      <H>Sending</H>
      <p.Row k="A day">at most {m.dailyCap} loop emails across every mailbox</p.Row>
      <p.Row k="Baseline">{Math.round(m.baselineShare * 100)}% of each type&apos;s emails go to the unchanged baseline</p.Row>
      <p.Row k="Approaches">at most {m.maxLive} live per customer type</p.Row>
      <p.Row k="Cold">{m.coldEnabled ? "on" : "off until you say go"}</p.Row>
      <p.Row k="Apollo">{m.apolloCredits ? `${m.apolloCredits} credits a week` : "no credits to spend"}</p.Row>
      <p.Row k="Pause">every loop send stops if unsubscribes pass {Math.round(m.unsubPause * 100)}% in 7 days</p.Row>
      <H>Who</H>
      <p.Row k="Two weeks">no email about an event under {m.minDaysBeforeEvent} days away (Fair Workweek: staff are scheduled two weeks out)</p.Row>
      <p.Row k="Size">groups under {m.minGuests} people get the cake pointer, not catering</p.Row>
      <p.Row k="Lost deals">held back {m.holdBackMonths} months</p.Row>
      <p.Row k="Never email">{m.neverEmail ? `${m.neverEmail} addresses and domains` : "nobody listed"}</p.Row>
      <H>Will say</H>
      <ul className="list-disc space-y-0.5 pl-4 text-xs">
        {m.willSay.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <H>Won&apos;t say</H>
      <ul className="list-disc space-y-0.5 pl-4 text-xs">
        {m.wontSay.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <H>Offers and occasions</H>
      <p.Row k="Offers">{m.allowedOffers.join(", ")}; anything else waits for you</p.Row>
      <p.Row k="Occasions">{m.approvedAsk.length ? m.approvedAsk.join(", ") : "only those rated a good fit; none of the 'ask' ones approved yet"}</p.Row>
      <H>Research</H>
      <p.Row k="LinkedIn">
        {m.linkedinCap} company pages a day, {m.linkedinPause}s apart, on Alex&apos;s account, read only
      </p.Row>
      <div className="mt-3">{p.Proto({ label: "Ask for a change…" })}</div>
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

/** The loop's third bullet row in "This week": against the 4-week average. */
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
