// PROTOTYPE (bj-finance #811), throwaway. attentionItems() stands in for the
// spec's `attention_items` Postgres view (section 3, R9): ONE function returns
// one row per open item, and every badge on the screen (object glyph, region
// label, the Needs you pill) is a rollup of these rows by path prefix. Nothing
// else on the screen decides a colour.
//
// The five rules of spec section 8.1: reply aging, mailbox frozen or silent,
// steps due with no copy, check overdue, held people past N days.
// Thresholds are placeholders from spec section 9.

import {
  COPY_DUE_WARN_DAYS,
  HELD_STALE_DAYS,
  LANE_LABEL,
  sendingAfternoon,
  type Facts,
  type LaneKey,
} from "./facts";
import { businessMinutesBetween, dowEt, etParts, fmtAge, isWeekday } from "./time";

export type Level = "warning" | "caution" | "ready";
export const LEVEL_RANK: Record<Level, number> = { warning: 3, caution: 2, ready: 1 };

/** What a badge row points at. Every home is a URL state on the one screen. */
export type Home =
  | { kind: "mailbox"; id: string }
  | { kind: "step"; lane: LaneKey; n: number }
  | { kind: "lane"; lane: LaneKey }
  | { kind: "reply"; id: string }
  | { kind: "check"; domain: string; check: "seed" | "blocklist" };

export type AttentionItem = {
  id: string;
  rule: "reply_aging" | "mailbox_frozen" | "mailbox_silent" | "step_no_copy" | "check_overdue" | "held_stale";
  level: Level;
  /** The pill's area word ("■ 2 · Sending"). */
  area: string;
  /** Home path, root first: sending/<domain>/<mailbox>, lanes/<lane>/step:<n>, replies/<id>. */
  path: string[];
  pathLabel: string;
  home: Home;
  title: string;
  detail: string;
  openedAt: string | null;
  /** Open more than 48 hours (R8): "stale: fix the cause or the rule". */
  stale: boolean;
  /** 1 to 3 fixes (R10: a rule with no clearing action raises no badge). */
  fixes: string[];
  /** Objects harmed by this item whose home is elsewhere (◇, never counted). */
  affects: Home[];
  synthetic?: string;
};

export type IdleItem = { id: string; text: string; home: Home };

const REPLY_CAUTION_MIN = 120; // 2 business hours (placeholder, 9.1)
const REPLY_WARNING_MIN = 240; // 4 business hours (placeholder, 9.1)
const STALE_MS = 48 * 3_600_000;

export function attentionItems(f: Facts): AttentionItem[] {
  const now = new Date(f.now);
  const items: AttentionItem[] = [];
  const dom = (id: string) => f.domains.find((d) => d.id === id)?.domain ?? id;
  const stale = (at: string | null) => !!at && now.getTime() - new Date(at).getTime() > STALE_MS;

  // 1. Reply aging (R8): ● new, ▲ at 2 business hours, ■ at 4.
  for (const r of f.replies) {
    if (r.handledAt) continue;
    const mins = businessMinutesBetween(new Date(r.at), now);
    const level: Level = mins >= REPLY_WARNING_MIN ? "warning" : mins >= REPLY_CAUTION_MIN ? "caution" : "ready";
    const where = r.lane ? `${LANE_LABEL[r.lane]}${r.step ? ` › step ${r.step}` : ""}` : "lane unknown";
    items.push({
      id: `reply:${r.id}`,
      rule: "reply_aging",
      level,
      area: "Replies",
      path: ["replies", r.id],
      pathLabel: `Replies › ${where}`,
      home: { kind: "reply", id: r.id },
      title: level === "ready" ? "New reply" : `Reply waiting ${fmtAge(mins)}`,
      detail: `${where} · unclaimed · ${fmtAge(mins)} in business hours`,
      openedAt: r.at,
      stale: stale(r.at),
      fixes: ["Reply", "Hand off to catering", "Not a lead"],
      affects: r.lane && r.step ? [{ kind: "step", lane: r.lane, n: r.step }] : [],
      synthetic: r.synthetic,
    });
  }

  // 2. Mailbox frozen (stopped by the rules) or silent.
  for (const m of f.mailboxes) {
    const d = dom(m.domainId);
    const path = ["sending", m.domainId, m.id];
    const pathLabel = `Sending › ${d} › ${m.short}`;
    const usedBy = f.lanes.filter((l) => l.mailboxIds.includes(m.id)).map((l) => ({ kind: "lane", lane: l.key }) as Home);
    if (m.frozen && m.frozenBy === "rules") {
      const auth = /5\.7\.|auth/i.test(m.frozenReason ?? "");
      items.push({
        id: `frozen:${m.id}`,
        rule: "mailbox_frozen",
        level: "warning",
        area: "Sending",
        path,
        pathLabel,
        home: { kind: "mailbox", id: m.id },
        title: `${m.short} stopped sending`,
        detail: m.frozenReason ?? "stopped by the rules",
        openedAt: m.frozenAt,
        stale: stale(m.frozenAt),
        fixes: m.fixes ?? (auth ? ["Check DNS now", "Move queued sends", "Shelve…"] : ["Open the checklist", "Resume at half cap", "Shelve…"]),
        affects: usedBy,
        synthetic: m.synthetic,
      });
      continue;
    }
    // Unexpected silence is a Caution, never dark (spec R2): a weekday
    // afternoon, allowance left, it sent in the last 7 days, and nothing today.
    if (!m.frozen && m.cap > 0 && m.sentToday === 0 && (m.sentPrev7 ?? 0) > 0 && sendingAfternoon(now)) {
      items.push({
        id: `silent:${m.id}`,
        rule: "mailbox_silent",
        level: "caution",
        area: "Sending",
        path,
        pathLabel,
        home: { kind: "mailbox", id: m.id },
        title: `${m.short} has sent nothing today`,
        detail: `0 of ${m.cap} by ${etParts(now).hour}:00 on a sending weekday; it sent ${m.sentPrev7} in the 7 days before`,
        openedAt: null,
        stale: false,
        fixes: ["Open the sender log", "Shelve…"],
        affects: usedBy,
      });
    }
  }

  // 3. Steps due with no copy: COPY_DUE_WARN_DAYS before people are due, and
  // never when no plan says a touch is due (spec 9.8).
  for (const l of f.lanes) {
    if (l.status !== "running") continue;
    for (const s of l.steps) {
      if (s.written || !s.due || s.due.soon === 0) continue;
      const when = s.due.firstDue ? dowEt(s.due.firstDue) : "now";
      items.push({
        id: `copy:${l.key}:${s.n}`,
        rule: "step_no_copy",
        level: "caution",
        area: l.label,
        path: ["lanes", l.key, `step:${s.n}`],
        pathLabel: `Lanes › ${l.label} › Step ${s.n}`,
        home: { kind: "step", lane: l.key, n: s.n },
        title: `${s.due.soon} due ${when} · no copy`,
        detail: `${s.due.soon} people are due step ${s.n} from ${when} (within ${COPY_DUE_WARN_DAYS} days). No copy is written for step ${s.n}.`,
        openedAt: null,
        stale: false,
        fixes: [`Write step ${s.n}`, `Finish these ${s.due.soon}`, "Shelve until…"],
        affects: [],
        synthetic: s.synthetic,
      });
    }
  }

  // 4. Checks overdue, or never run. "No data" (nothing records the check
  // yet) is its own gray state and raises nothing: there is no clearing
  // action until the checks table exists.
  for (const d of f.domains) {
    for (const c of d.checks) {
      if (c.nodata) continue;
      const age = c.lastRunAt ? Math.floor((now.getTime() - new Date(c.lastRunAt).getTime()) / 86_400_000) : null;
      if (age !== null && age <= c.everyDays) continue;
      items.push({
        id: `check:${d.id}:${c.kind}`,
        rule: "check_overdue",
        level: "caution",
        area: "Checks",
        path: ["sending", d.id, `check:${c.kind}`],
        pathLabel: `Sending › ${d.domain} › ${c.label}`,
        home: { kind: "check", domain: d.id, check: c.kind },
        title: age === null ? `${c.label} never run` : `${c.label} overdue ${age - c.everyDays}d`,
        detail: age === null ? `No ${c.label.toLowerCase()} recorded for ${d.domain}.` : `Last run ${age} days ago. Due every ${c.everyDays}.`,
        openedAt: null,
        stale: false,
        fixes: ["Record new result", "Shelve 3 days"],
        affects: [],
        synthetic: c.synthetic,
      });
    }
  }

  // 5. Held people past N days with nothing scheduled: no sequence, or moved
  // tiers with no new step. (Blocked providers are a standing policy and
  // "copy not written" is rule 3's item, so neither is counted twice.)
  for (const l of f.lanes) {
    if (l.status !== "running" || l.heldStale === 0) continue;
    items.push({
      id: `held:${l.key}`,
      rule: "held_stale",
      level: "caution",
      area: l.label,
      path: ["lanes", l.key, "held"],
      pathLabel: `Lanes › ${l.label} › Held`,
      home: { kind: "lane", lane: l.key },
      title: `${l.heldStale} held ${HELD_STALE_DAYS}d+ with no next step`,
      detail: `Held as "no sequence yet" or "moved tiers, no new step", last emailed ${HELD_STALE_DAYS}+ days ago or never.`,
      openedAt: null,
      stale: false,
      fixes: ["Give them a sequence", "Release held…", "Shelve…"],
      affects: [],
    });
  }

  return items.sort(
    (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || (a.openedAt ?? "9").localeCompare(b.openedAt ?? "9"),
  );
}

/** Idle (spec idea 13): silent under-use no error rule catches. Gray only in
 * v1 (spec 9.10). */
export function idleItems(f: Facts): IdleItem[] {
  const now = new Date(f.now);
  const out: IdleItem[] = [];
  for (const l of f.lanes)
    if (l.status === "running" && l.upNext === 0)
      out.push({ id: `idle:lane:${l.key}`, text: `${l.label} has nobody up next (queue ran dry)`, home: { kind: "lane", lane: l.key } });
  if (isWeekday(now) && etParts(now).hour >= 15)
    for (const m of f.mailboxes)
      if (!m.frozen && m.sentToday !== null && m.cap > 0 && m.sentToday < m.cap / 4)
        out.push({ id: `idle:mb:${m.id}`, text: `${m.short} at ${m.sentToday} of ${m.cap} by 3pm`, home: { kind: "mailbox", id: m.id } });
  return out;
}

export type Rollup = { level: Level | null; count: number; items: AttentionItem[] };

/** R1/R5: the worst level and the open-item count under a path prefix. */
export function rollup(items: AttentionItem[], prefix: string[]): Rollup {
  const under = items.filter((i) => prefix.every((p, k) => i.path[k] === p));
  let level: Level | null = null;
  for (const i of under) if (!level || LEVEL_RANK[i.level] > LEVEL_RANK[level]) level = i.level;
  return { level, count: under.length, items: under };
}

/** Is this home harmed by an item whose home is elsewhere (◇)? */
export function affectedBy(items: AttentionItem[], home: Home): AttentionItem[] {
  const same = (a: Home, b: Home) => JSON.stringify(a) === JSON.stringify(b);
  return items.filter((i) => i.affects.some((h) => same(h, home)));
}
