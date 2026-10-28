"use client";

// THROWAWAY PROTOTYPE (bj-finance #811): the one-screen Email campaigns
// console, Layout A of the round 2 spec ("Keep one screen dark until
// something matters"). One screen; detail lives in popovers, one non-modal
// side panel with a breadcrumb, one task layer inside it, and a confirm modal.
// Panel state is in the URL query string (history.pushState, so opening a
// panel does not refetch the page). Every action is marked PROTOTYPE and does
// nothing: no writes, no localStorage, no sessionStorage.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  affectedBy,
  rollup,
  type AttentionItem,
  type Home,
  type IdleItem,
} from "@/lib/emailCampaignsPrototype/console/attention";
import {
  HELD_STALE_DAYS,
  LANE_LABEL,
  TOO_EARLY_N,
  type Facts,
  type LaneFact,
  type LaneKey,
  type MailboxFact,
  type StepFact,
} from "@/lib/emailCampaignsPrototype/console/facts";
import { SCENARIOS, type ScenarioKey } from "@/lib/emailCampaignsPrototype/console/scenarios";
import { businessMinutesBetween, dateEt, dowEt, etDay as etDayOf, fmtAge, timeEt } from "@/lib/emailCampaignsPrototype/console/time";
import { HELD_REASON_SHORT, type HeldReason, type TierKey } from "@/lib/emailCampaignsPrototype/model";
import { Badge, Bullet, FunnelIcon, Glyph, LEVEL_BORDER, LEVEL_TEXT, NoData, Rate, Spark, SyntheticTag } from "./bits";

type Props = {
  facts: Facts;
  items: AttentionItem[];
  idle: IdleItem[];
  scenario: ScenarioKey;
  source: "real" | "synthetic";
};

// --- URL state ----------------------------------------------------------------

type Nav = { panel?: string; sel?: string; layer?: string; add?: string; modal?: string; tab?: string; dim?: string };
const NAV_KEYS: (keyof Nav)[] = ["panel", "sel", "layer", "add", "modal", "tab", "dim"];

function homeToNav(h: Home): Nav {
  switch (h.kind) {
    case "mailbox":
      return { panel: `mailbox:${h.id}` };
    case "lane":
      return { panel: `lane:${h.lane}` };
    case "step":
      return { panel: `lane:${h.lane}`, sel: `step:${h.n}` };
    case "reply":
      return { panel: "replies", sel: `reply:${h.id}` };
    case "check":
      return { panel: `domain:${h.domain}`, sel: `check:${h.check}` };
  }
}

/** One level up: modal, then the add-step form, then layer, then crumb, then panel closed. */
function parentOf(n: Nav): Nav {
  if (n.modal) return { ...n, modal: undefined };
  if (n.add) return { ...n, add: undefined };
  if (n.layer) return { ...n, layer: undefined };
  if (n.sel) return { ...n, sel: undefined };
  return { dim: n.dim };
}

function useNav() {
  const sp = useSearchParams();
  const pathname = usePathname();
  const pushed = useRef(0);
  const nav: Nav = {};
  for (const k of NAV_KEYS) {
    const v = sp.get(k);
    if (v) nav[k] = v;
  }
  const href = useCallback(
    (n: Nav) => {
      const q = new URLSearchParams(sp.toString());
      // The add-step form only lives inside Edit lane.
      if (n.layer !== "editlane") n = { ...n, add: undefined };
      for (const k of NAV_KEYS) q.delete(k);
      for (const k of NAV_KEYS) if (n[k]) q.set(k, n[k]!);
      const s = q.toString();
      return s ? `${pathname}?${s}` : pathname;
    },
    [sp, pathname],
  );
  // Drilling pushes a history entry (Back pops one level); tab switches replace.
  const dimNow = sp.get("dim") ?? undefined;
  const go = useCallback(
    (n: Nav, mode: "push" | "replace" = "push") => {
      // "Dim the rest" survives drilling unless a call sets it.
      if (!("dim" in n)) n = { ...n, dim: dimNow };
      if (mode === "push") {
        window.history.pushState(null, "", href(n));
        pushed.current++;
      } else window.history.replaceState(null, "", href(n));
    },
    [href, dimNow],
  );
  const pop = useCallback(() => {
    if (pushed.current > 0) {
      pushed.current--;
      window.history.back();
    } else window.history.replaceState(null, "", href(parentOf(nav)));
  }, [href, nav]);
  return { nav, go, pop, href };
}

// --- prototype action feedback --------------------------------------------------

function useProtoToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((what: string) => {
    setMsg(`PROTOTYPE: "${what}" does nothing here. Nothing was saved or sent.`);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setMsg(null), 3200);
  }, []);
  return { msg, say };
}

function ProtoButton({ label, onClick, say, primary, proto }: { label: string; onClick?: () => void; say: (s: string) => void; primary?: boolean; proto?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => (onClick ? onClick() : say(label))}
      title={onClick && !proto ? undefined : "Prototype: does nothing"}
      className={`rounded border px-2 py-1 text-xs ${
        primary ? "border-slate-300 bg-slate-200 text-slate-900 hover:bg-white" : "border-slate-600 text-slate-200 hover:bg-slate-800"
      }`}
    >
      {label}
      {onClick && !proto ? null : <span className={`ml-1 text-[9px] uppercase tracking-wide ${primary ? "text-fuchsia-700" : "text-fuchsia-300"}`}>proto</span>}
    </button>
  );
}

// --- popovers -----------------------------------------------------------------

type Pop = { id: string; rect: DOMRect; title: string; body: ReactNode };

function Popover({ pop, onClose }: { pop: Pop; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    setPhone(window.innerWidth < 640);
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => document.addEventListener("mousedown", down), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", down);
    };
  }, [onClose]);
  const style = phone
    ? undefined
    : {
        top: Math.min(pop.rect.bottom + 6, window.innerHeight - 80),
        left: Math.max(8, Math.min(pop.rect.left, window.innerWidth - 400)),
      };
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={pop.title}
      style={style}
      className={
        phone
          ? "fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-auto rounded-t-xl border-t border-slate-600 bg-slate-900 p-4 shadow-2xl"
          : "fixed z-50 w-[380px] max-w-[calc(100vw-16px)] rounded-md border border-slate-600 bg-slate-900 p-3 shadow-2xl"
      }
    >
      <div className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-200">
        <span>{pop.title}</span>
        <button type="button" onClick={onClose} className="rounded px-2 py-0.5 text-slate-400 hover:bg-slate-800">
          {phone ? "Close" : "✕"}
        </button>
      </div>
      <div className="text-xs text-slate-300">{pop.body}</div>
    </div>
  );
}

// --- the screen -----------------------------------------------------------------

export default function ConsoleScreen({ facts: f, items, idle, scenario, source }: Props) {
  const { nav, go, pop, href } = useNav();
  const { msg, say } = useProtoToast();
  const [popover, setPopover] = useState<Pop | null>(null);
  const [acked, setAcked] = useState(false);
  const [palette, setPalette] = useState(false);
  const idleIx = useRef(0);
  const dim = nav.dim === "1";

  const openPop = (e: React.MouseEvent, id: string, title: string, body: ReactNode) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopover((p) => (p?.id === id ? null : { id, rect, title, body }));
  };
  const closePop = useCallback(() => setPopover(null), []);

  const dirty = useRef(false);
  const escape = useCallback(() => {
    if (popover) return setPopover(null);
    if (palette) return setPalette(false);
    const inForm = !nav.modal && (!!nav.layer || nav.panel === "newlane");
    if (inForm && dirty.current && !window.confirm("Discard what you typed?")) return;
    if (inForm) dirty.current = false;
    if (nav.panel || nav.modal) pop();
  }, [popover, palette, nav, pop]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") escape();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [escape]);

  const all = rollup(items, []);
  const replyItems = rollup(items, ["replies"]);
  const lanesR = rollup(items, ["lanes"]);
  const sendingR = rollup(items, ["sending"]);
  const worst = all.items[0];
  const openReplies = f.replies.filter((r) => !r.handledAt);
  const oldest = openReplies.map((r) => businessMinutesBetween(new Date(r.at), new Date(f.now))).sort((a, b) => b - a)[0];
  const mb = (id: string) => f.mailboxes.find((m) => m.id === id);
  const dom = (id: string) => f.domains.find((d) => d.id === id);
  const fade = (has: boolean) => (dim && !has ? "opacity-25" : "");

  // --- header ---------------------------------------------------------------
  const pill = (
    <button
      type="button"
      onClick={(e) => {
        setAcked(true);
        openPop(
          e,
          "pill",
          "Needs you",
          <div className="space-y-2">
            {all.items.length === 0 ? <p className="text-slate-400">Nothing open. Every rule below checked on page load.</p> : null}
            {all.items.map((i) => (
              <div key={i.id} className="border-b border-slate-800 pb-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-slate-100">
                    <Glyph mark={i.level} /> {i.title}
                    <SyntheticTag what={i.synthetic} />
                  </span>
                  <span className="shrink-0 text-slate-400">
                    {i.openedAt ? (etDayOf(i.openedAt) === f.today ? timeEt(i.openedAt) : dateEt(i.openedAt)) : ""}{" "}
                    <button
                      type="button"
                      className="ml-1 rounded border border-slate-600 px-1.5 text-slate-100 hover:bg-slate-800"
                      onClick={() => {
                        setPopover(null);
                        go(homeToNav(i.home));
                      }}
                    >
                      Go ▸
                    </button>
                  </span>
                </div>
                <div className="text-slate-400">{i.detail}</div>
                <div className="text-slate-500">
                  {i.pathLabel}
                  {i.stale ? <span className="ml-1 text-amber-300">· stale: fix the cause or the rule</span> : null}
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                className="rounded border border-slate-600 px-2 py-0.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  setPopover(null);
                  go({ ...nav, dim: dim ? undefined : "1" }, "replace");
                }}
              >
                {dim ? "Show everything" : "Dim the rest"}
              </button>
              <ProtoButton label="Busy until 6pm…" say={say} />
            </div>
          </div>,
        );
      }}
      aria-label={all.level ? `Needs you: ${all.count} open, worst in ${worst?.area}` : "Needs you: nothing open"}
      className={`rounded-full border px-3 py-1 text-sm ${
        all.level ? `${LEVEL_BORDER[all.level]} ${LEVEL_TEXT[all.level]} font-semibold ${acked ? "" : "animate-pulse"}` : "border-slate-600 text-slate-400"
      }`}
    >
      {all.level ? (
        <>
          <Glyph mark={all.level} /> {all.count} · {worst?.area}
        </>
      ) : (
        "Needs you"
      )}
    </button>
  );

  const nowMs = new Date(f.now).getTime();

  // --- lanes ----------------------------------------------------------------
  // Lane name: the Edit lane layer (Add step lives only in there).
  const editLane = (l: LaneFact) => () => go({ ...nav, panel: `lane:${l.key}`, sel: undefined, layer: "editlane", modal: undefined });
  const lanesByTier = [...f.lanes].sort((a, b) => TIER_ORDER.indexOf(LANE_TIER[a.key]) - TIER_ORDER.indexOf(LANE_TIER[b.key]));

  const laneRow = (l: LaneFact) => {
    const r = rollup(items, ["lanes", l.key]);
    const affected = affectedBy(items, { kind: "lane", lane: l.key });
    const waiting = l.waitingOn.filter((w) => mb(w.mailboxId));
    const has = r.count > 0 || affected.length > 0;
    if (l.status !== "running")
      return (
        <div key={l.key} className={`border-t border-slate-800 py-2 ${fade(has)}`}>
          <button type="button" onClick={editLane(l)} className="flex flex-wrap items-center gap-x-2 text-left text-sm text-slate-400 hover:text-slate-200">
            <FunnelIcon tier={LANE_TIER[l.key]} />
            <Glyph mark="off" />
            <span className="font-semibold text-slate-300">{l.label}</span>
            <span className="text-slate-500">{l.who}</span>
            <span>
              {l.status === "paused" ? `paused since ${l.pausedSince ? dateEt(l.pausedSince) : "?"} · ${l.statusNote}` : l.statusNote}
            </span>
            <span className="text-slate-500">· {l.upNext + l.emailed + l.held} people</span>
          </button>
          {waiting.length ? (
            <AffectedLine
              text={`waiting on ${waiting.length} stopped mailbox${waiting.length > 1 ? "es" : ""} (${waiting.map((w) => mb(w.mailboxId)!.short).join(", ")})`}
              onClick={() => go({ ...nav, panel: `mailbox:${waiting[0].mailboxId}`, sel: undefined })}
            />
          ) : null}
        </div>
      );
    return (
      <div key={l.key} className={`border-t border-slate-800 py-2 ${fade(has)}`}>
        <div className="grid grid-cols-[1fr_auto] items-baseline gap-2 sm:grid-cols-[minmax(0,1fr)_64px_64px_64px_120px]">
          <button type="button" onClick={editLane(l)} className="flex items-baseline gap-2 text-left hover:text-white">
            <FunnelIcon tier={LANE_TIER[l.key]} />
            <span className="text-sm font-semibold text-slate-100">{l.label}</span>
            <Badge r={r} label={`${l.label} lane`} />
            <span className="hidden text-xs text-slate-500 sm:inline">{l.who}</span>
          </button>
          <span className="text-right text-sm tabular-nums text-slate-300 sm:hidden">
            {l.upNext} · {l.emailed} · {l.held}
          </span>
          {(["upNext", "emailed", "held"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => go({ ...nav, panel: `lane:${l.key}`, sel: undefined, layer: undefined })}
              className="hidden text-right text-sm tabular-nums text-slate-300 hover:text-white sm:block"
            >
              {l[k]}
            </button>
          ))}
          <span className="hidden text-right text-sm tabular-nums text-slate-400 sm:block">
            {l.week.replies} · {l.week.quotes} · {l.week.bookings}
          </span>
        </div>
        {/* Phone: lanes are cards and the steps show in the lane's sheet (spec 4, phone). */}
        <div className="mt-1 hidden flex-wrap items-center gap-1 sm:flex">
          {l.steps.length === 0 ? <span className="text-xs text-slate-500">no sequence</span> : null}
          {l.steps.map((s, i) => (
            <span key={s.n} className="flex items-center gap-1">
              {i > 0 ? <span className="text-slate-600">→</span> : null}
              <StepBox lane={l} s={s} items={items} onClick={() => go({ ...nav, panel: `lane:${l.key}`, sel: `step:${s.n}`, layer: undefined })} />
            </span>
          ))}
        </div>
        {waiting.map((w) => (
          <AffectedLine
            key={w.mailboxId}
            text={`${w.n ?? "?"} sends waiting on ${mb(w.mailboxId)!.short}`}
            onClick={() => go({ ...nav, panel: `mailbox:${w.mailboxId}`, sel: undefined })}
          />
        ))}
      </div>
    );
  };

  // --- sending --------------------------------------------------------------
  const mailboxTile = (m: MailboxFact) => {
    const r = rollup(items, ["sending", m.domainId, m.id]);
    return (
      <button
        key={m.id}
        type="button"
        onClick={() => go({ ...nav, panel: `mailbox:${m.id}`, sel: undefined, layer: undefined })}
        className={`flex min-w-[150px] flex-col items-start rounded px-1.5 py-1 text-left hover:bg-slate-900 ${fade(r.count > 0)}`}
        aria-label={`${m.address}${m.frozen ? ", stopped" : m.sentToday === null ? ", no data" : `, ${m.sentToday} of ${m.cap} sent today`}`}
      >
        <span className="flex items-center gap-1 text-xs text-slate-300">
          {m.short}
          <Badge r={r} label={m.short} />
          <SyntheticTag what={m.synthetic} />
        </span>
        {m.frozen ? (
          <span className={`text-xs font-semibold ${m.frozenBy === "rules" ? "text-red-400" : "text-slate-400"}`}>
            {m.frozenBy === "rules" ? <Glyph mark="warning" /> : <Glyph mark="off" />} stopped {m.frozenAt ? (etDayOf(m.frozenAt) === f.today ? timeEt(m.frozenAt) : dateEt(m.frozenAt)) : ""}
          </span>
        ) : m.sentToday === null ? (
          <NoData>sends not stored</NoData>
        ) : (
          <span className="flex items-center gap-1 text-[11px] tabular-nums text-slate-400">
            <Bullet value={m.sentToday} target={m.cap} band={m.band} /> {m.sentToday}/{m.cap}
          </span>
        )}
      </button>
    );
  };

  const checkChip = (domainId: string, c: Facts["domains"][number]["checks"][number]) => {
    const r = rollup(items, ["sending", domainId, `check:${c.kind}`]);
    const d = dom(domainId)!;
    const age = c.lastRunAt ? Math.floor((nowMs - new Date(c.lastRunAt).getTime()) / 86_400_000) : null;
    return (
      <button
        key={c.kind}
        type="button"
        className={`rounded border px-1.5 py-0.5 text-[11px] ${
          r.level ? `${LEVEL_BORDER[r.level]} ${LEVEL_TEXT[r.level]}` : c.nodata ? "border-dashed border-slate-600 text-slate-500" : "border-slate-700 text-slate-400"
        } ${fade(r.count > 0)}`}
        onClick={(e) =>
          openPop(
            e,
            `check:${domainId}:${c.kind}`,
            `${c.label} · ${d.domain}`,
            <div className="space-y-1.5">
              {c.nodata ? (
                <p>
                  <Glyph mark="nodata" /> No data. Nothing records {c.kind === "seed" ? "seed tests" : "blocklist checks"} yet: it needs the small checks
                  table the spec lists as a prerequisite (section 9.14). Due every {c.everyDays} day{c.everyDays > 1 ? "s" : ""} once it exists.
                </p>
              ) : (
                <>
                  <p>
                    {r.level ? <Glyph mark={r.level} /> : null}{" "}
                    {age !== null && age > c.everyDays ? `Overdue ${age - c.everyDays} day${age - c.everyDays > 1 ? "s" : ""}. ` : ""}Due every {c.everyDays} days.
                    <SyntheticTag what={c.synthetic} />
                  </p>
                  <p>
                    Last run {c.lastRunAt ? dateEt(c.lastRunAt) : "never"}
                    {c.result ? `: ${c.result}` : ""}
                  </p>
                </>
              )}
              <div className="flex gap-2 pt-1">
                <ProtoButton
                  label="Record new result"
                  say={say}
                  onClick={() => {
                    setPopover(null);
                    go({ ...nav, panel: `domain:${domainId}`, sel: `check:${c.kind}`, layer: "record" });
                  }}
                />
                {r.level ? <ProtoButton label="Shelve 3 days" say={say} /> : null}
              </div>
            </div>,
          )
        }
      >
        {r.level ? <Glyph mark={r.level} /> : c.nodata ? <Glyph mark="nodata" /> : null} {c.label}{" "}
        {c.nodata ? "No data" : age === null ? "never" : `${age}d${age > c.everyDays ? ` · due every ${c.everyDays}` : ""}`}
      </button>
    );
  };

  // --- this week ------------------------------------------------------------
  const weekBar = (key: "replies" | "quotes" | "bookings", label: string) => {
    const w = f.week[key];
    return (
      <button
        key={key}
        type="button"
        className={`flex items-center gap-2 rounded px-1 py-0.5 text-xs text-slate-300 hover:bg-slate-900 ${fade(false)}`}
        onClick={(e) =>
          openPop(
            e,
            `week:${key}`,
            `${label}, last 7 days`,
            <div className="space-y-1">
              <p>
                {w.n} this week · 4-week average {w.avg4.toFixed(1)}
              </p>
              {f.lanes.map((l) => (
                <p key={l.key} className="text-slate-400">
                  {l.label}: {l.week[key]}
                </p>
              ))}
              {key !== "replies" ? (
                <p className="text-slate-400">
                  Not from an email lane: {f.week.notFromEmail[key]} (unattributed)
                </p>
              ) : null}
              <p className="text-slate-500">
                {key === "replies"
                  ? "Replies logged by the reply reader (outreach_events)."
                  : "Deals opened in the last 7 days by people in a lane, by their stage now. Deals carry no stage-change dates, so this is not the week's quotes sent."}
              </p>
            </div>,
          )
        }
      >
        <span className="w-16 text-left text-slate-400">{label}</span>
        <Bullet value={w.n} target={w.avg4} width={80} />
        <span className="tabular-nums">
          {w.n} <span className="text-slate-500">(4-wk avg {w.avg4.toFixed(1)})</span>
        </span>
      </button>
    );
  };

  // --- render ---------------------------------------------------------------
  const panelOpen = !!nav.panel;
  return (
    <div className={`relative pb-24 text-slate-200 ${panelOpen ? "sm:pr-[480px]" : ""}`}>
      <div className="mx-auto max-w-[1280px] px-4 py-3">
        {/* ① HEADER */}
        <section aria-label="Header" className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {pill}
            <button
              type="button"
              onClick={() => go({ ...nav, panel: "replies", sel: undefined, layer: undefined })}
              className={`rounded-full border px-3 py-1 text-sm ${
                replyItems.level ? `${LEVEL_BORDER[replyItems.level]} ${LEVEL_TEXT[replyItems.level]}` : "border-slate-700 text-slate-400"
              }`}
            >
              {replyItems.level ? <Glyph mark={replyItems.level} /> : null} Replies {openReplies.length}
              {oldest !== undefined ? ` · ${replyItems.level === "ready" ? "new" : fmtAge(oldest)}` : ""}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!idle.length) return;
                const it = idle[idleIx.current % idle.length];
                idleIx.current++;
                go(homeToNav(it.home));
              }}
              title={idle.length ? idle.map((i) => i.text).join("\n") : "Nothing idle"}
              className="rounded-full border border-slate-700 px-3 py-1 text-sm text-slate-400"
            >
              Idle{idle.length ? ` ${idle.length}` : ""}
            </button>
            <span className="ml-auto flex items-center gap-3 text-xs text-slate-500">
              <button
                type="button"
                onClick={(e) => openPop(e, "memo", "MEMO: overrides in effect", <MemoList f={f} say={say} />)}
                title="Overrides in effect"
                className="hover:text-slate-300"
              >
                MEMO {f.memo.length}
              </button>
              <button
                type="button"
                onClick={(e) => openPop(e, "shelf", "Shelf", <p>Nothing shelved. Shelving is a prototype button here: nothing is stored, so nothing comes back at expiry.</p>)}
                className="hover:text-slate-300"
              >
                Shelf 0
              </button>
              <button
                type="button"
                onClick={(e) => openPop(e, "recall", "Recall", <p>Nothing held. Busy mode is a prototype button here, so nothing is held for recall.</p>)}
                className="hover:text-slate-300"
              >
                Recall 0
              </button>
              <button type="button" onClick={() => setPalette(true)} className="rounded border border-slate-700 px-1.5 hover:text-slate-300">
                ⌘K
              </button>
            </span>
          </div>
        </section>

        {/* ② LANES */}
        <section aria-label="Lanes" className="mt-3">
          <div className="grid grid-cols-[1fr_auto] items-baseline gap-2 text-[11px] uppercase tracking-wide text-slate-500 sm:grid-cols-[minmax(0,1fr)_64px_64px_64px_120px]">
            <span className="flex items-center gap-2">
              Lanes <Badge r={lanesR} label="Lanes" />
              <PlusButton label="Add lane" onClick={() => go({ panel: "newlane", dim: nav.dim })} />
            </span>
            <span className="text-right sm:hidden">next · emailed · held</span>
            <span className="hidden text-right sm:block">Up next</span>
            <span className="hidden text-right sm:block">Emailed</span>
            <span className="hidden text-right sm:block">Held</span>
            <span className="hidden text-right normal-case sm:block">7 days: rep · quote · book</span>
          </div>
          {lanesByTier.map(laneRow)}
        </section>

        {/* ③ SENDING */}
        <section aria-label="Sending" className="mt-3 border-t border-slate-700 pt-2">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
            Sending <Badge r={sendingR} label="Sending" />
          </div>
          {f.domains.map((d) => (
            <div key={d.id} className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-900 py-1">
              <button
                type="button"
                onClick={() => go({ ...nav, panel: `domain:${d.id}`, sel: undefined, layer: undefined })}
                className="w-full text-left text-xs text-slate-400 hover:text-slate-200 sm:w-56"
              >
                {d.domain} <span className="text-slate-600">({d.lane})</span> <Badge r={rollup(items, ["sending", d.id])} label={d.domain} />
              </button>
              <div className="flex flex-wrap gap-1">{d.mailboxIds.map((id) => mailboxTile(mb(id)!))}</div>
              <div className="ml-auto flex gap-1">{d.checks.map((c) => checkChip(d.id, c))}</div>
            </div>
          ))}
          <p className="mt-1 text-[10px] text-slate-600">bar = sent today · | = daily cap · shading = normal band (last 10 sending days)</p>
        </section>

        {/* ④ THIS WEEK */}
        <section aria-label="This week" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-700 pt-2">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">This week</span>
          {weekBar("replies", "Replies")}
          {weekBar("quotes", "Quotes")}
          {weekBar("bookings", "Bookings")}
        </section>
      </div>

      {popover ? <Popover pop={popover} onClose={closePop} /> : null}
      {nav.panel ? (
        <SidePanel f={f} items={items} nav={nav} go={go} pop={pop} href={href} say={say} dirty={dirty} escape={escape} />
      ) : null}
      {nav.modal ? <ConfirmModal f={f} nav={nav} pop={pop} say={say} /> : null}
      {palette ? <Palette f={f} onClose={() => setPalette(false)} go={(n) => { setPalette(false); go(n); }} /> : null}
      {msg ? (
        <div role="status" className="fixed bottom-20 left-1/2 z-[70] -translate-x-1/2 rounded bg-fuchsia-950 px-3 py-2 text-xs text-fuchsia-100 shadow-lg">
          {msg}
        </div>
      ) : null}
      <ScenarioBar scenario={scenario} source={source} />
    </div>
  );
}

// --- small pieces ----------------------------------------------------------------

function AffectedLine({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-1 block rounded border border-slate-500 px-1.5 py-0.5 text-left text-xs text-slate-300 hover:bg-slate-900" title="Affected by a problem whose home is elsewhere. Not counted.">
      <Glyph mark="affected" /> {text} ▸
    </button>
  );
}

/** Prototype "+" (owner review 2026-10-28): opens a form that saves nothing. */
function PlusButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} (prototype)`}
      title={`${label}. Prototype: changes nothing.`}
      className="inline-flex items-center gap-1 rounded border border-dashed border-slate-600 px-1.5 py-0.5 text-xs normal-case text-slate-400 hover:border-slate-400 hover:text-slate-100"
    >
      <span aria-hidden className="text-sm font-semibold leading-none">+</span>
      <span className="text-[9px] uppercase tracking-wide text-fuchsia-300">proto</span>
    </button>
  );
}

// Prototype only: the funnel tier each lane sits in, and what puts a person in
// it (read off laneOf in facts.ts). Wedding is an offer-tier lane (owner, 2026-10-28).
const TIER_ORDER: TierKey[] = ["cold", "warm", "offer"];
const LANE_TIER: Record<LaneKey, TierKey> = { cold: "cold", warm: "warm", wedding: "offer", offer: "offer" };
const LANE_TRIGGER: Record<LaneKey, string> = {
  cold: "Added to the cold engine as an Apollo prospect.",
  warm: "In the warm engine (past customer or enquirer), not booked in the last 12 months, not opted in to offers, not a wedding contact.",
  wedding: "In the warm engine with category wedding (expo leads).",
  offer: "Booked in the last 12 months, or opted in to offers (wedding contacts excepted).",
};

function StepBox({ lane, s, items, onClick }: { lane: LaneFact; s: StepFact; items: AttentionItem[]; onClick: () => void }) {
  const r = rollup(items, ["lanes", lane.key, `step:${s.n}`]);
  const aff = affectedBy(items, { kind: "step", lane: lane.key, n: s.n });
  const replyDot = aff.find((i) => i.rule === "reply_aging");
  if (!s.written) {
    const due = s.due && s.due.soon > 0;
    return (
      <button
        type="button"
        onClick={onClick}
        className={`rounded border border-dashed px-2 py-1 text-left text-xs ${r.level ? `${LEVEL_BORDER[r.level]} ${LEVEL_TEXT[r.level]}` : "border-slate-600 text-slate-500"}`}
      >
        <span className="font-semibold">{s.n}</span>{" "}
        {due && r.level ? (
          <>
            <Glyph mark={r.level} /> {s.due!.soon} due {s.due!.firstDue ? dowEt(s.due!.firstDue).split(",")[0] : "now"} · no copy
          </>
        ) : (
          <>┄ no copy · {s.reached} waiting ┄</>
        )}
        <SyntheticTag what={s.synthetic} />
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} className="rounded border border-slate-700 bg-slate-900/60 px-2 py-1 text-left text-xs text-slate-300 hover:border-slate-500">
      <span className="font-semibold text-slate-100">{s.n}</span> {s.label}{" "}
      <span className="tabular-nums text-slate-400">
        {s.sent === null ? <NoData>sends not stored</NoData> : <>{s.sent} sent · {s.replied} of {s.sent} rep</>}
      </span>
      {replyDot ? (
        <span className="ml-1">
          <Glyph mark={replyDot.level} />
        </span>
      ) : null}
    </button>
  );
}

function MemoList({ f, say }: { f: Facts; say: (s: string) => void }) {
  if (!f.memo.length) return <p>No overrides in effect.</p>;
  return (
    <div className="space-y-2">
      {f.memo.map((m) => (
        <div key={m.id}>
          <p className="text-slate-100">{m.text}</p>
          <p className="text-slate-400">
            {m.who} · since {m.since ? dateEt(m.since) : "not recorded"} · {m.ends ? `ends ${dateEt(m.ends)}` : "no end set (every override should expire)"}
          </p>
          <div className="mt-1 flex gap-2">
            <ProtoButton label="End now" say={say} />
            <ProtoButton label="Extend" say={say} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ScenarioBar({ scenario, source }: { scenario: ScenarioKey; source: "real" | "synthetic" }) {
  const router = useRouter();
  const sp = useSearchParams();
  const pathname = usePathname();
  const set = (k: ScenarioKey) => {
    const q = new URLSearchParams(sp.toString());
    for (const key of NAV_KEYS) q.delete(key);
    if (k === "none") q.delete("scenario");
    else q.set("scenario", k);
    const s = q.toString();
    router.push(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
  const ix = SCENARIOS.findIndex((x) => x.key === scenario);
  const step = (d: number) => set(SCENARIOS[(ix + d + SCENARIOS.length) % SCENARIOS.length].key);
  return (
    <div className="fixed bottom-3 left-1/2 z-[60] flex max-w-[calc(100vw-16px)] -translate-x-1/2 items-center gap-1 rounded-full border-2 border-fuchsia-400 bg-black px-2 py-1 text-xs text-fuchsia-100 shadow-xl">
      <span className="hidden font-bold uppercase tracking-wide text-fuchsia-300 sm:inline">Prototype</span>
      <button type="button" onClick={() => step(-1)} className="rounded-full px-2 hover:bg-fuchsia-900" aria-label="Previous scenario">
        ←
      </button>
      <select
        aria-label="Scenario"
        value={scenario}
        onChange={(e) => set(e.target.value as ScenarioKey)}
        className="max-w-[210px] rounded bg-black text-fuchsia-100"
      >
        {SCENARIOS.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => step(1)} className="rounded-full px-2 hover:bg-fuchsia-900" aria-label="Next scenario">
        →
      </button>
      <span className="hidden text-fuchsia-300 sm:inline">· {source === "real" ? "real data" : "synthetic fixture"}</span>
    </div>
  );
}

function Palette({ f, onClose, go }: { f: Facts; onClose: () => void; go: (n: Nav) => void }) {
  const [q, setQ] = useState("");
  const entries = useMemo(() => {
    const e: { label: string; nav: Nav }[] = [{ label: "Replies", nav: { panel: "replies" } }];
    for (const l of f.lanes) {
      e.push({ label: `${l.label} lane`, nav: { panel: `lane:${l.key}` } });
      for (const s of l.steps) e.push({ label: `${l.label} › step ${s.n}`, nav: { panel: `lane:${l.key}`, sel: `step:${s.n}` } });
    }
    for (const m of f.mailboxes) e.push({ label: `Mailbox ${m.short} (${m.address.split("@")[1]})`, nav: { panel: `mailbox:${m.id}` } });
    for (const d of f.domains) e.push({ label: `Domain ${d.domain}`, nav: { panel: `domain:${d.id}` } });
    return e;
  }, [f]);
  const shown = entries.filter((e) => e.label.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center bg-black/40 pt-24" onMouseDown={onClose}>
      <div className="w-[420px] max-w-[calc(100vw-32px)] rounded-md border border-slate-600 bg-slate-900 p-2" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown[0]) go(shown[0].nav);
          }}
          placeholder="Jump to a lane, step, mailbox, domain…"
          className="w-full rounded bg-slate-800 px-2 py-1.5 text-sm text-slate-100 outline-none"
        />
        <ul className="mt-1 max-h-72 overflow-auto text-sm">
          {shown.map((e) => (
            <li key={e.label}>
              <button type="button" onClick={() => go(e.nav)} className="w-full rounded px-2 py-1 text-left text-slate-300 hover:bg-slate-800">
                {e.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// --- the side panel ----------------------------------------------------------------

type PanelProps = {
  f: Facts;
  items: AttentionItem[];
  nav: Nav;
  go: (n: Nav, mode?: "push" | "replace") => void;
  pop: () => void;
  href: (n: Nav) => string;
  say: (s: string) => void;
  dirty: React.MutableRefObject<boolean>;
  escape: () => void;
};

function AlertBlock({ items, say, onFix }: { items: AttentionItem[]; say: (s: string) => void; onFix?: (fix: string) => (() => void) | undefined }) {
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      {items.map((i) => (
        <div key={i.id} className={`rounded border-l-4 ${LEVEL_BORDER[i.level]} bg-slate-950 p-2`}>
          <p className={`text-sm font-semibold ${LEVEL_TEXT[i.level]}`}>
            <Glyph mark={i.level} /> {i.title}
            <SyntheticTag what={i.synthetic} />
          </p>
          <p className="text-xs text-slate-300">{i.detail}</p>
          {i.openedAt ? <p className="text-xs text-slate-500">since {dowEt(i.openedAt)}, {timeEt(i.openedAt)}{i.stale ? " · stale: fix the cause or the rule" : ""}</p> : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate-500">Fix</span>
            {i.fixes.map((fx) => (
              <ProtoButton key={fx} label={fx} say={say} onClick={onFix?.(fx)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 py-1 text-xs">
      <span className="text-slate-500">{k}</span>
      <span className="text-slate-200">{children}</span>
    </div>
  );
}

function SidePanel(p: PanelProps) {
  const { f, nav, go, escape } = p;
  const [wide, setWide] = useState(false);
  const [kind, id] = (nav.panel ?? "").split(":");
  const crumbs: { label: string; nav: Nav | null }[] = [];
  const base: Nav = { panel: nav.panel, dim: nav.dim };
  let body: ReactNode = null;

  if (kind === "mailbox") {
    const m = f.mailboxes.find((x) => x.id === id);
    const d = f.domains.find((x) => x.id === m?.domainId);
    if (m && d) {
      crumbs.push({ label: "Sending", nav: null }, { label: d.domain, nav: { panel: `domain:${d.id}`, dim: nav.dim } }, { label: m.short, nav: base });
      body = <MailboxBody {...p} m={m} />;
    }
  } else if (kind === "domain") {
    const d = f.domains.find((x) => x.id === id);
    if (d) {
      crumbs.push({ label: "Sending", nav: null }, { label: d.domain, nav: base });
      const [sk, sid] = (nav.sel ?? "").split(":");
      if (sk === "check") {
        const c = d.checks.find((x) => x.kind === sid);
        crumbs.push({ label: `${c?.label ?? sid} test`, nav: { ...base, sel: nav.sel } });
        body = c ? <CheckBody {...p} domainId={d.id} c={c} /> : null;
      } else body = <DomainBody {...p} d={d} />;
    }
  } else if (kind === "lane") {
    const l = f.lanes.find((x) => x.key === id);
    if (l) {
      crumbs.push({ label: "Lanes", nav: null }, { label: l.label, nav: base });
      const [sk, sid] = (nav.sel ?? "").split(":");
      const s = sk === "step" ? l.steps.find((x) => x.n === Number(sid)) : undefined;
      if (nav.layer === "editlane") {
        crumbs.push({ label: "Edit lane", nav: { ...base, layer: "editlane" } });
        if (nav.add === "step") crumbs.push({ label: "Add step", nav: null });
        body = <EditLaneBody {...p} l={l} />;
      } else if (s) {
        crumbs.push({ label: `Step ${s.n}`, nav: { ...base, sel: nav.sel } });
        body = <StepBody {...p} l={l} s={s} />;
      } else body = <LaneBody {...p} l={l} />;
    }
  } else if (kind === "newlane") {
    crumbs.push({ label: "Lanes", nav: null }, { label: "Add lane", nav: null });
    body = <AddLaneBody {...p} />;
  } else if (kind === "replies") {
    crumbs.push({ label: "Replies", nav: base });
    const [sk, sid] = (nav.sel ?? "").split(":");
    const r = sk === "reply" ? f.replies.find((x) => x.id === sid) : undefined;
    if (r) {
      crumbs.push({ label: "Reply", nav: { ...base, sel: nav.sel } });
      body = <ReplyBody {...p} r={r} />;
    } else body = <RepliesBody {...p} />;
  }
  if (!body) body = <p className="text-sm text-slate-400">Nothing here (the link points at something that is not on the screen).</p>;
  if (nav.layer && nav.layer !== "editlane") crumbs.push({ label: nav.layer === "record" ? "Record result" : nav.layer === "reply" ? "Compose" : "Edit", nav: null });

  return (
    <aside
      role="region"
      aria-label={crumbs.map((c) => c.label).join(" › ")}
      className={`fixed inset-0 z-40 flex flex-col border-l border-slate-700 bg-slate-900 shadow-2xl sm:inset-auto sm:bottom-0 sm:right-0 sm:top-0 ${
        wide ? "sm:w-[min(900px,85vw)]" : "sm:w-[480px]"
      }`}
    >
      <header className="flex items-center gap-2 border-b border-slate-700 px-3 py-2">
        <button type="button" onClick={escape} className="rounded px-1.5 text-sm text-slate-300 hover:bg-slate-800 sm:hidden">
          ‹ Back
        </button>
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs text-slate-400">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 ? <span className="text-slate-600">›</span> : null}
              {c.nav && i < crumbs.length - 1 ? (
                <button type="button" onClick={() => go(c.nav!)} className="hover:text-slate-100 hover:underline">
                  {c.label}
                </button>
              ) : (
                <span className={i === crumbs.length - 1 ? "font-semibold text-slate-100" : ""}>{c.label}</span>
              )}
            </span>
          ))}
        </nav>
        <button type="button" onClick={() => setWide((w) => !w)} className="hidden rounded px-1.5 text-slate-400 hover:bg-slate-800 sm:block" title="Widen">
          ⤢
        </button>
        <button type="button" onClick={() => go({ dim: nav.dim })} className="rounded px-1.5 text-slate-400 hover:bg-slate-800" aria-label="Close panel">
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-auto p-3 pb-16">{body}</div>
      <span className="sr-only">Esc goes back one level.</span>
    </aside>
  );
}

function TaskLayer({ title, children, onSave, saveLabel, extra, p }: { title: string; children: ReactNode; onSave: () => void; saveLabel: string; extra?: ReactNode; p: PanelProps }) {
  return (
    <div className="flex h-full flex-col">
      <p className="mb-2 text-sm font-semibold text-slate-100">{title}</p>
      <div className="flex-1 space-y-2" onInput={() => (p.dirty.current = true)}>
        {children}
      </div>
      <div className="sticky bottom-0 mt-3 flex gap-2 border-t border-slate-700 bg-slate-900 pt-2">
        <ProtoButton label={saveLabel} say={p.say} primary proto onClick={() => { p.dirty.current = false; onSave(); }} />
        {extra}
        <ProtoButton label="Cancel" say={p.say} onClick={() => p.escape()} />
      </div>
    </div>
  );
}

const input = "w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100";

function MailboxBody(p: PanelProps & { m: MailboxFact }) {
  const { m, f, items, say, go, nav } = p;
  const [nums, setNums] = useState(false);
  const mine = items.filter((i) => i.home.kind === "mailbox" && i.home.id === m.id);
  // Score (spec idea 12, 9.7: a number in the panel only). Bounces on the
  // round 1 ladder: 2 in 100 = 1, 3 in 100 = 2, 5 in 200 = 3; auth rejection = 3.
  const auth = /5\.7\.|auth/i.test(m.frozenReason ?? "") ? 3 : 0;
  const b = m.bounces14;
  const bounceScore = b >= 5 ? 3 : b >= 3 ? 2 : b >= 2 ? 1 : 0;
  return (
    <div className="space-y-3">
      <AlertBlock
        items={mine}
        say={say}
        onFix={(fx) => (fx.startsWith("Move") ? () => go({ ...nav, modal: "move" }) : undefined)}
      />
      {m.frozen && !mine.length ? (
        <p className="text-xs text-slate-400">
          {m.frozenBy === "rules" ? "Stopped by the rules" : "Paused by hand"}: {m.frozenReason}
        </p>
      ) : null}
      <div>
        <Row k="Address">{m.address}</Row>
        <Row k="Today">
          {m.sentToday === null ? <NoData>Apollo sends are not stored</NoData> : <>{m.sentToday} sent of {m.cap} cap</>}
          {" · "}
          {m.bouncesToday} bounces today
        </Row>
        <Row k="Cap">{m.capNote}</Row>
        <Row k="Score">
          {auth + bounceScore} <span className="text-slate-500">(auth {auth} · bounces {bounceScore} · complaints No data)</span>
        </Row>
        <Row k="Bounces 14d">
          {m.sends14 === null ? (
            <>{m.bounces14} tied to this box · sends <NoData /></>
          ) : (
            <Rate k={m.bounces14} n={m.sends14} min={200} />
          )}
          {f.bouncesNoMailbox14 ? <span className="block text-slate-500">{f.bouncesNoMailbox14} bounces in 14 days are not tied to any mailbox</span> : null}
        </Row>
        <Row k="14 days">
          {m.days14 ? (
            <span className="flex items-center gap-2">
              <Spark values={m.days14.map((x) => x.n)} />
              <button type="button" onClick={() => setNums((n) => !n)} className="rounded border border-slate-700 px-1.5 text-[11px] text-slate-300">
                {nums ? "Hide numbers" : "Show numbers"}
              </button>
            </span>
          ) : (
            <NoData />
          )}
        </Row>
        {nums && m.days14 ? (
          <div className="ml-[104px] grid grid-cols-2 gap-x-4 text-[11px] tabular-nums text-slate-400">
            {m.days14.map((x) => (
              <span key={x.day}>
                {x.day.slice(5)}: {x.n}
              </span>
            ))}
          </div>
        ) : null}
        <Row k="Lanes using it">
          {m.waiting?.length
            ? m.waiting.map((w) => `${LANE_LABEL[w.lane]} ${w.n} waiting`).join(" · ")
            : m.lanesUsing.length
              ? m.lanesUsing.map((u) => `${LANE_LABEL[u.lane]} ${u.sent14}`).join(" · ") + " (14 days)"
              : "none in 14 days"}
        </Row>
      </div>
    </div>
  );
}

function DomainBody(p: PanelProps & { d: Facts["domains"][number] }) {
  const { d, f, go, nav, items } = p;
  return (
    <div className="space-y-2 text-xs">
      <p className="text-slate-400">
        {d.mailboxIds.length} mailbox{d.mailboxIds.length > 1 ? "es" : ""} on {d.domain} ({d.lane} lane). Authentication (SPF, DKIM, DMARC) and Postmaster:
        <span className="ml-1">
          <NoData>not read by the prototype</NoData>
        </span>
      </p>
      {d.mailboxIds.map((id) => {
        const m = f.mailboxes.find((x) => x.id === id)!;
        return (
          <button key={id} type="button" onClick={() => go({ panel: `mailbox:${id}`, dim: nav.dim })} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-slate-800">
            <span className="w-28 text-slate-200">{m.short}</span>
            <Badge r={rollup(items, ["sending", d.id, id])} label={m.short} />
            <span className="text-slate-400">{m.frozen ? "stopped" : m.sentToday === null ? "No data" : `${m.sentToday}/${m.cap} today`}</span>
          </button>
        );
      })}
      {d.checks.map((c) => (
        <button key={c.kind} type="button" onClick={() => go({ ...nav, sel: `check:${c.kind}` })} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-slate-800">
          <span className="w-28 text-slate-200">{c.label} test</span>
          {c.nodata ? <NoData /> : <span className="text-slate-400">last run {c.lastRunAt ? dateEt(c.lastRunAt) : "never"}</span>}
        </button>
      ))}
    </div>
  );
}

function CheckBody(p: PanelProps & { domainId: string; c: Facts["domains"][number]["checks"][number] }) {
  const { c, items, say, nav, go } = p;
  const mine = items.filter((i) => i.home.kind === "check" && i.home.domain === p.domainId && i.home.check === c.kind);
  if (nav.layer === "record")
    return (
      <TaskLayer p={p} title={`Record a ${c.label.toLowerCase()} result`} saveLabel="Save result" onSave={() => say("Save result")}>
        <p className="text-xs text-slate-500">Inbox, spam and missing counts per provider. PROTOTYPE: nothing is saved (there is no checks table yet).</p>
        {["Gmail", "Microsoft", "Yahoo"].map((prov) => (
          <div key={prov} className="grid grid-cols-[80px_1fr_1fr_1fr] items-center gap-2 text-xs">
            <span className="text-slate-300">{prov}</span>
            {["inbox", "spam", "missing"].map((k) => (
              <label key={k} className="text-slate-500">
                {k}
                <input type="number" min={0} className={input} />
              </label>
            ))}
          </div>
        ))}
        <label className="block text-xs text-slate-500">
          Ran at
          <input type="datetime-local" className={input} />
        </label>
      </TaskLayer>
    );
  return (
    <div className="space-y-2 text-xs">
      <AlertBlock items={mine} say={say} onFix={(fx) => (fx.startsWith("Record") ? () => go({ ...nav, layer: "record" }) : undefined)} />
      {c.nodata ? (
        <p className="text-slate-400">
          <Glyph mark="nodata" /> No data: nothing records this check yet. The spec&apos;s prerequisite is a small checks table (type, ran at, result).
        </p>
      ) : (
        <>
          <Row k="Last run">{c.lastRunAt ? dateEt(c.lastRunAt) : "never"} <SyntheticTag what={c.synthetic} /></Row>
          <Row k="Result">{c.result ?? "none"}</Row>
          <Row k="Due">every {c.everyDays} days</Row>
        </>
      )}
      <ProtoButton label="Record new result" say={say} onClick={() => go({ ...nav, layer: "record" })} />
    </div>
  );
}

function LaneBody(p: PanelProps & { l: LaneFact }) {
  const { l, f, items, say, go, nav } = p;
  const mine = items.filter((i) => i.path[0] === "lanes" && i.path[1] === l.key && !i.path[2]?.startsWith("step"));
  return (
    <div className="space-y-3 text-xs">
      <AlertBlock items={mine} say={say} />
      <p className="text-slate-400">
        {l.who}. {l.status !== "running" ? <span className="text-slate-300"><Glyph mark="off" /> {l.statusNote}</span> : null}
      </p>
      <div>
        <Row k="Up next">{l.upNext}</Row>
        <Row k="Emailed">{l.emailed}</Row>
        <Row k="Held">
          {l.held}
          {(Object.keys(l.heldBy) as HeldReason[])
            .filter((r) => l.heldBy[r] > 0)
            .map((r) => (
              <span key={r} className="block text-slate-400">
                {l.heldBy[r]} {HELD_REASON_SHORT[r]}
              </span>
            ))}
          {l.heldStale ? <span className="block text-slate-500">{l.heldStale} of them held with nothing next, last emailed {HELD_STALE_DAYS}+ days ago or never</span> : null}
        </Row>
        <Row k="7 days">
          {l.week.replies} replies · {l.week.quotes} quotes · {l.week.bookings} bookings
        </Row>
        <Row k="People lists">
          <NoData>not built in the prototype (the tab has them)</NoData>
        </Row>
      </div>
      <div>
        <p className="mb-1 text-slate-500">Sequence: {l.sequenceName ?? "none"}</p>
        {l.steps.map((s) => (
          <button key={s.n} type="button" onClick={() => go({ ...nav, sel: `step:${s.n}` })} className="flex w-full gap-2 rounded px-1 py-1 text-left hover:bg-slate-800">
            <span className="w-4 text-slate-500">{s.n}</span>
            <span className="flex-1 text-slate-200">{s.written ? s.label : "no copy"}</span>
            <Badge r={rollup(items, ["lanes", l.key, `step:${s.n}`])} label={`step ${s.n}`} />
            <span className="text-slate-400">{s.sent === null ? "No data" : `${s.sent} sent`}</span>
          </button>
        ))}
      </div>
      <div>
        <p className="mb-1 text-slate-500">Boxes sending this lane (14 days)</p>
        {f.mailboxes
          .filter((m) => m.lanesUsing.some((u) => u.lane === l.key) || l.mailboxIds.includes(m.id))
          .map((m) => (
            <p key={m.id} className="text-slate-300">
              {m.short} {m.frozen ? "· stopped" : ""} · {m.lanesUsing.find((u) => u.lane === l.key)?.sent14 ?? 0} logged
            </p>
          ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <ProtoButton label={l.status === "paused" ? "Resume lane…" : "Pause lane…"} say={say} />
        <ProtoButton label="Daily cap…" say={say} />
        <ProtoButton label="Mute (Ready only)" say={say} />
      </div>
    </div>
  );
}

function ProtoNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-fuchsia-800 bg-fuchsia-950/40 px-2 py-1 text-[11px] text-fuchsia-200">
      <span className="mr-1 font-bold uppercase tracking-wide">Proto</span>
      {children}
    </p>
  );
}

function TierPicker({ value, onChange }: { value: TierKey; onChange: (t: TierKey) => void }) {
  return (
    <div role="radiogroup" aria-label="Tier" className="flex gap-1">
      {TIER_ORDER.map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={value === t}
          onClick={() => onChange(t)}
          className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs capitalize ${
            value === t ? "border-slate-300 bg-slate-800 text-slate-100" : "border-slate-700 text-slate-400 hover:bg-slate-800"
          }`}
        >
          <FunnelIcon tier={t} /> {t}
        </button>
      ))}
    </div>
  );
}

function AddLaneBody(p: PanelProps) {
  const { f, say } = p;
  const [tier, setTier] = useState<TierKey>("warm");
  return (
    <TaskLayer p={p} title="Add lane" saveLabel="Add lane" onSave={() => say("Add lane")}>
      <ProtoNote>Nothing is saved: no lane is created and nobody is enrolled.</ProtoNote>
      <label className="block text-xs text-slate-300">
        Trigger <span className="text-slate-500">(what puts a person into this lane)</span>
        <textarea autoFocus rows={3} className={input} placeholder="e.g. category is wedding, or booked in the last 12 months" />
      </label>
      <div className="text-[11px] text-slate-500">
        <p>Triggers of the lanes now:</p>
        {[...f.lanes]
          .sort((a, b) => TIER_ORDER.indexOf(LANE_TIER[a.key]) - TIER_ORDER.indexOf(LANE_TIER[b.key]))
          .map((l) => (
            <p key={l.key}>
              <span className="text-slate-400">{l.label}:</span> {LANE_TRIGGER[l.key]}
            </p>
          ))}
      </div>
      <label className="block text-xs text-slate-300">
        Name
        <input className={input} placeholder="e.g. Holiday parties" />
      </label>
      <div className="text-xs text-slate-300">
        <p className="mb-1">Tier</p>
        <TierPicker value={tier} onChange={setTier} />
      </div>
    </TaskLayer>
  );
}

function EditLaneBody(p: PanelProps & { l: LaneFact }) {
  const { l, say, go, nav, dirty } = p;
  const adding = nav.add === "step";
  const next = (l.steps.at(-1)?.n ?? 0) + 1;
  const addRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) addRef.current?.focus();
  }, [adding]);
  return (
    <div className="space-y-4 text-xs">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-100">
        <FunnelIcon tier={LANE_TIER[l.key]} /> Edit lane · {l.label}
        <span className="text-xs font-normal text-slate-500">{LANE_TIER[l.key]} tier</span>
      </p>
      <ProtoNote>Nothing here changes the lane. Every button only shows a note.</ProtoNote>

      <section aria-label="Trigger">
        <p className="mb-1 text-slate-500">Trigger (what puts a person into this lane)</p>
        <p className="text-slate-200">{LANE_TRIGGER[l.key]}</p>
        <div className="mt-1.5">
          <ProtoButton label="Change trigger…" say={say} />
        </div>
      </section>

      <section aria-label="Steps">
        <p className="mb-1 text-slate-500">Steps{l.sequenceName ? ` · ${l.sequenceName}` : ""}</p>
        {l.steps.length === 0 ? <p className="text-slate-500">No steps yet.</p> : null}
        {l.steps.map((s) => (
          <button
            key={s.n}
            type="button"
            onClick={() => go({ ...nav, sel: `step:${s.n}`, layer: undefined })}
            className="flex w-full gap-2 rounded px-1 py-1 text-left hover:bg-slate-800"
          >
            <span className="w-4 text-slate-500">{s.n}</span>
            <span className={`flex-1 ${s.written ? "text-slate-200" : "text-slate-500"}`}>{s.written ? s.label : "no copy"}</span>
            <span className="text-slate-400">{s.n === 1 ? "on enrolment" : `wait ${s.waitDays} days`}</span>
          </button>
        ))}
        {adding ? (
          <div className="mt-2 space-y-2 rounded border border-slate-600 p-2" onInput={() => (dirty.current = true)}>
            <p className="font-semibold text-slate-100">Add step {next}</p>
            <label className="block text-slate-500">
              Subject
              <input ref={addRef} className={input} />
            </label>
            <label className="block text-slate-500">
              Wait (days after the last email)
              <input type="number" min={0} defaultValue={next === 1 ? 0 : 7} className={input} />
            </label>
            <div className="flex gap-2">
              <ProtoButton label="Add step" say={say} primary proto onClick={() => { dirty.current = false; say("Add step"); }} />
              <ProtoButton label="Cancel" say={say} onClick={() => p.escape()} />
            </div>
          </div>
        ) : (
          <div className="mt-1">
            <ProtoButton label="+ Add step" say={say} proto onClick={() => go({ ...nav, add: "step" })} />
          </div>
        )}
      </section>

      <section aria-label="Lane controls">
        <p className="mb-1 text-slate-500">Lane</p>
        <div className="flex flex-wrap gap-2">
          <ProtoButton label="Stop" say={say} />
          <ProtoButton label="Mute" say={say} />
          <ProtoButton label="Archive" say={say} />
        </div>
      </section>
    </div>
  );
}

function StepBody(p: PanelProps & { l: LaneFact; s: StepFact }) {
  const { l, s, f, items, say, nav, go } = p;
  const mine = items.filter((i) => i.home.kind === "step" && i.home.lane === l.key && i.home.n === s.n);
  if (nav.layer === "edit")
    return (
      <TaskLayer
        p={p}
        title={`Write step ${s.n} · ${l.label}`}
        saveLabel="Save draft"
        onSave={() => say("Save draft")}
        extra={<ProtoButton label="Set live…" say={say} onClick={() => go({ ...nav, modal: "live" })} />}
      >
        <p className="text-xs text-slate-500">PROTOTYPE: nothing is saved. A saved draft would keep the badge and add &quot;draft&quot;; only Set live clears it.</p>
        <label className="block text-xs text-slate-500">
          Subject
          <input className={input} />
        </label>
        <label className="block text-xs text-slate-500">
          Body
          <textarea rows={8} className={input} />
        </label>
        <Row k="Mailbox">{l.mailboxIds.map((id) => f.mailboxes.find((m) => m.id === id)?.short).join(", ") || "none"}</Row>
        <Row k="Send window">wait {s.waitDays} days after the last email</Row>
      </TaskLayer>
    );
  return (
    <div className="space-y-3 text-xs">
      <AlertBlock
        items={mine}
        say={say}
        onFix={(fx) => (fx.startsWith("Write") ? () => go({ ...nav, layer: "edit" }) : undefined)}
      />
      <div>
        <Row k="Copy">{s.written ? s.label : <span className="text-slate-500">no copy written</span>}</Row>
        <Row k="Wait">{s.n === 1 ? "on enrolment" : `${s.waitDays} days after the last email`}</Row>
        <Row k="Sent">{s.sent === null ? <NoData>Apollo-side sends are not stored</NoData> : s.sent}</Row>
        <Row k="Replied">{s.sent === null ? <NoData /> : <Rate k={s.replied} n={s.sent} min={TOO_EARLY_N} />}</Row>
        <Row k="Unsubscribed">
          <NoData>not tied to a step yet</NoData>
        </Row>
        <Row k="Opens">
          {s.engagement ? (
            <span className="text-slate-400">
              {s.engagement.opened} of {s.engagement.tracked} tracked · clicks {s.engagement.clicked} <span className="text-slate-500">(includes machine opens)</span>
            </span>
          ) : (
            <NoData>none tracked</NoData>
          )}
        </Row>
        <Row k="People">
          {s.reached} have this step next
          {s.due ? (
            <span className="block text-slate-400">
              {s.due.soon} due within 3 days{s.due.firstDue ? ` (from ${dowEt(s.due.firstDue)})` : ""} · {s.due.later} due later <SyntheticTag what={s.synthetic} />
            </span>
          ) : null}
        </Row>
        <Row k="Keys">{s.keys.join(", ")}</Row>
      </div>
      <div className="flex flex-wrap gap-2">
        <ProtoButton label={s.written ? "Edit" : `Write step ${s.n}`} say={say} onClick={() => go({ ...nav, layer: "edit" })} />
        {!s.written ? <ProtoButton label="Set live…" say={say} onClick={() => go({ ...nav, modal: "live" })} /> : null}
      </div>
    </div>
  );
}

function RepliesBody(p: PanelProps) {
  const { f, items, go, nav } = p;
  const tab = nav.tab ?? "now";
  const now = f.replies.filter((r) => !r.handledAt).sort((a, b) => a.at.localeCompare(b.at));
  const done = f.replies.filter((r) => r.handledAt).sort((a, b) => b.at.localeCompare(a.at));
  const list = tab === "done" ? done : tab === "later" ? [] : now;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex gap-1">
        {[
          ["now", `Now ${now.length}`],
          ["later", "Later 0"],
          ["done", `Done ${done.length}`],
        ].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => go({ ...nav, tab: k === "now" ? undefined : k }, "replace")}
            className={`rounded px-2 py-0.5 ${tab === k ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:bg-slate-800"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {list.length === 0 ? <p className="text-slate-500">{tab === "later" ? "Nothing set for later (prototype: Later is not stored)." : "No replies here."}</p> : null}
      {list.map((r) => {
        const it = items.find((i) => i.id === `reply:${r.id}`);
        const mins = businessMinutesBetween(new Date(r.at), new Date(r.handledAt ?? f.now));
        return (
          <button key={r.id} type="button" onClick={() => go({ ...nav, sel: `reply:${r.id}` })} className="block w-full rounded border border-slate-700 p-2 text-left hover:border-slate-500">
            <span className="flex items-center justify-between">
              <span className={it ? LEVEL_TEXT[it.level] : "text-slate-300"}>
                {it ? <Glyph mark={it.level} /> : null} {r.handledAt ? `answered in ${fmtAge(mins)}` : fmtAge(mins)}
                <SyntheticTag what={r.synthetic} />
              </span>
              <span className="text-slate-500">{r.handledAt ? "handled" : "unclaimed"}</span>
            </span>
            <span className="block text-slate-400">
              {r.lane ? LANE_LABEL[r.lane as LaneKey] : "lane unknown"}
              {r.step ? ` › step ${r.step}` : ""} · {dateEt(r.at)} {timeEt(r.at)}
            </span>
            {r.example ? <span className="block text-slate-300">&quot;{r.example}&quot; (example)</span> : null}
          </button>
        );
      })}
      <p className="text-[11px] text-slate-500">Reply text is never read by the prototype; only the synthetic scenario shows an example line.</p>
    </div>
  );
}

function ReplyBody(p: PanelProps & { r: Facts["replies"][number] }) {
  const { r, items, say, nav, go } = p;
  const mine = items.filter((i) => i.id === `reply:${r.id}`);
  if (nav.layer === "reply")
    return (
      <TaskLayer p={p} title="Reply" saveLabel="Send" onSave={() => say("Send")}>
        <p className="text-xs text-slate-500">PROTOTYPE: nothing is sent. Opening this card would mark it &quot;has it&quot; for the other two people.</p>
        <textarea rows={10} className={input} placeholder="Your reply…" />
      </TaskLayer>
    );
  return (
    <div className="space-y-3 text-xs">
      <AlertBlock items={mine} say={say} onFix={(fx) => (fx === "Reply" ? () => go({ ...nav, layer: "reply" }) : undefined)} />
      <Row k="Lane">{r.lane ? LANE_LABEL[r.lane as LaneKey] : "unknown"}{r.step ? ` › step ${r.step}` : ""}</Row>
      <Row k="Received">{dowEt(r.at)}, {timeEt(r.at)}</Row>
      <Row k="Handled">{r.handledAt ? `${dowEt(r.handledAt)}, ${timeEt(r.handledAt)}` : "not yet"}</Row>
      <Row k="Thread">{r.example ? <>&quot;{r.example}&quot; (example) <SyntheticTag what={r.synthetic} /></> : <NoData>thread text not read by the prototype</NoData>}</Row>
      {!mine.length ? (
        <div className="flex flex-wrap gap-2">
          <ProtoButton label="Reply" say={say} onClick={() => go({ ...nav, layer: "reply" })} />
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <ProtoButton label="Later: until…" say={say} />
        </div>
      )}
    </div>
  );
}

function ConfirmModal({ f, nav, pop, say }: { f: Facts; nav: Nav; pop: () => void; say: (s: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  let title = "Confirm";
  let text = "";
  const [kind, id] = (nav.panel ?? "").split(":");
  if (nav.modal === "move" && kind === "mailbox") {
    const m = f.mailboxes.find((x) => x.id === id);
    // Healthy boxes in the same lane, most room left today first.
    const others = f.mailboxes
      .filter((x) => x.id !== m?.id && x.lane === m?.lane && !x.frozen && x.sentToday !== null)
      .sort((a, b) => b.cap - (b.sentToday ?? 0) - (a.cap - (a.sentToday ?? 0)));
    const n = m?.waiting?.reduce((s, w) => s + w.n, 0) ?? 0;
    title = `Move ${n || "queued"} sends?`;
    text = `Move ${n || "the queued"} sends from ${m?.short} to ${others.slice(0, 2).map((o) => o.short).join(" and ")}? They go out today within those caps.`;
  } else if (nav.modal === "live") {
    const [, n] = (nav.sel ?? "").split(":");
    title = `Set step ${n} live?`;
    text = `Send step ${n} to the people due it, from their due date.`;
  }
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60" role="presentation">
      <div role="dialog" aria-modal="true" aria-label={title} className="w-[420px] max-w-[calc(100vw-32px)] rounded-md border border-slate-600 bg-slate-900 p-4">
        <p className="text-sm font-semibold text-slate-100">{title}</p>
        <p className="mt-1 text-xs text-slate-300">{text}</p>
        <p className="mt-2 text-[11px] text-fuchsia-300">PROTOTYPE: confirming does nothing.</p>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={pop} className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800">
            Cancel
          </button>
          <button
            ref={ref}
            type="button"
            onClick={() => {
              say(title);
              pop();
            }}
            className="rounded bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-900 hover:bg-white"
          >
            Confirm <span className="text-[9px] uppercase text-fuchsia-700">proto</span>
          </button>
        </div>
      </div>
    </div>
  );
}
