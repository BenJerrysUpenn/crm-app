// PROTOTYPE (bj-finance #811), throwaway. The one-screen Email campaigns
// console: rows in, facts out. Pure functions, nothing written anywhere.
//
// Lanes and people counts come from the Email campaigns tab's own model
// (model.ts compute + statesAt), so the console and the tab agree. Lanes here
// are the spec's four: Warm, Offer and Cold are the tab's tiers with the
// wedding contacts taken out, and Wedding is every prospect whose own category
// is 'wedding' (the wedding sender's list), counted against the wedding
// sequence. Badges are NOT computed here: attention.ts does that, in one place.

import {
  DEFAULT_CADENCE,
  categorySteps,
  compute,
  groupStanding,
  isExplicitOptIn,
  isUnwritten,
  specKeys,
  statesAt,
  stepEngagement,
  type CategoryStat,
  type Engagement,
  type HeldReason,
  type Payload,
  type ProspectRow,
  type RawData,
  type StepSpec,
  type TierKey,
} from "../model";
import { stepSpec, type SequenceDoc } from "../sequences";
import { resolveSequence, type SharedState } from "../sharedSequences";
import { parseNaiveUtc } from "@/lib/dateFormat";
import type { ConsoleExtras } from "./load";
import { etDay, etParts, isWeekday } from "./time";

export type LaneKey = "warm" | "offer" | "wedding" | "cold";
export const LANE_KEYS: LaneKey[] = ["warm", "offer", "wedding", "cold"];
export const LANE_LABEL: Record<LaneKey, string> = { warm: "Warm", offer: "Offer", wedding: "Wedding", cold: "Cold" };
const LANE_WHO: Record<LaneKey, string> = {
  warm: "past customers, enquirers",
  offer: "booked this year, opted in",
  wedding: "expo leads",
  cold: "prospects (Apollo)",
};

// Placeholders (spec: "starting values for Alina to set").
export const TOO_EARLY_N = 100; // a rate on fewer sends reads "too early"
export const COPY_DUE_WARN_DAYS = 3; // spec 9.8
export const HELD_STALE_DAYS = 14; // spec R8 "N days"
export const SEED_EVERY_DAYS = 14; // round 1 cadence
export const BLOCKLIST_EVERY_DAYS = 1;

export type StepFact = {
  n: number;
  label: string;
  written: boolean;
  waitDays: number;
  keys: string[];
  /** Sends logged with this step's templates to the lane's people. Null: not
   * stored (Apollo-side cold sends). */
  sent: number | null;
  replied: number;
  engagement: Engagement | null;
  /** People whose next step is this one. */
  reached: number;
  /** For an unwritten step: people due it within COPY_DUE_WARN_DAYS (or
   * already due), the first due date, and the rest. */
  due: { soon: number; later: number; firstDue: string | null } | null;
  synthetic?: string;
};

export type LaneFact = {
  key: LaneKey;
  label: string;
  who: string;
  status: "running" | "paused" | "nolane";
  statusNote: string | null;
  pausedSince: string | null;
  upNext: number;
  emailed: number;
  held: number;
  heldBy: Record<HeldReason, number>;
  /** Held with no sequence or no new step, emailed HELD_STALE_DAYS+ ago or never. */
  heldStale: number;
  steps: StepFact[];
  sequenceName: string | null;
  mailboxIds: string[];
  week: { replies: number; quotes: number; bookings: number };
  /** ◇ sends waiting on a stopped mailbox, when known. */
  waitingOn: { mailboxId: string; n: number | null }[];
};

export type MailboxFact = {
  id: string;
  address: string;
  short: string;
  domainId: string;
  lane: "warm" | "cold";
  cap: number;
  /** wedding_daily_allowance: the wedding sender uses only boxes with one. */
  weddingCap: number;
  capNote: string;
  sentToday: number | null;
  sentPrev7: number | null;
  band: [number, number] | null;
  days14: { day: string; n: number }[] | null;
  bouncesToday: number;
  bounces14: number;
  sends14: number | null;
  frozen: boolean;
  frozenReason: string | null;
  frozenAt: string | null;
  frozenBy: "rules" | "person" | null;
  ration: { n: number; at: string | null } | null;
  lanesUsing: { lane: LaneKey; sent14: number }[];
  synthetic?: string;
  fixes?: string[];
  waiting?: { lane: LaneKey; n: number }[];
};

export type CheckFact = {
  kind: "seed" | "blocklist";
  label: string;
  everyDays: number;
  /** True while nothing records this check (no checks table yet). */
  nodata: boolean;
  lastRunAt: string | null;
  result: string | null;
  synthetic?: string;
};

export type DomainFact = { id: string; domain: string; lane: "warm" | "cold"; mailboxIds: string[]; checks: CheckFact[] };

export type ReplyFact = {
  id: string;
  lane: LaneKey | null;
  step: number | null;
  at: string;
  handledAt: string | null;
  /** Only ever set on a synthetic reply. Real snippets are never read. */
  example?: string;
  synthetic?: string;
};

export type MemoFact = { id: string; text: string; who: string; since: string | null; ends: string | null };

export type Facts = {
  now: string;
  today: string;
  lanes: LaneFact[];
  mailboxes: MailboxFact[];
  domains: DomainFact[];
  replies: ReplyFact[];
  week: {
    replies: { n: number; avg4: number };
    quotes: { n: number; avg4: number };
    bookings: { n: number; avg4: number };
    notFromEmail: { quotes: number; bookings: number };
  };
  ticks: { at: string; kind: "send" | "reply" }[];
  memo: MemoFact[];
  bouncesNoMailbox14: number;
  notes: string[];
};

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const DAY = 86_400_000;
const QUOTE_STAGES = new Set(["Sent Quote", "Booked Unpaid", "Booked Paid", "Event Complete"]);
const BOOKED_STAGES = new Set(["Booked Unpaid", "Booked Paid", "Event Complete"]);
const HANDLED = new Set(["handed_off", "lost", "suppressed", "deal_created", "unsubscribed"]);

/** Which console lane a prospect row is in (for attributing its events).
 * Mirrors compute()'s routing: engine cold is Cold; warm with its own category
 * 'wedding' is Wedding; booked in 12 months or an explicit opt-in is Offer. */
function laneOf(p: ProspectRow, twelveAgo: string): LaneKey | null {
  if (p.engine === "cold") return "cold";
  if (p.engine !== "warm") return null;
  if (lc(p.category) === "wedding") return "wedding";
  const recent = p.ever_booked && (p.last_event_date ?? "") >= twelveAgo;
  return recent || isExplicitOptIn(p) ? "offer" : "warm";
}

function seqSteps(doc: SequenceDoc | null): StepSpec[] {
  return (doc?.steps ?? []).map(stepSpec);
}

export function buildFacts(raw: RawData, extras: ConsoleExtras, shared: SharedState, now: Date): Facts {
  const payload: Payload = compute(raw, now);
  const nowMs = now.getTime();
  const today = etDay(now);
  const twelve = new Date(now);
  twelve.setFullYear(twelve.getFullYear() - 1);
  const twelveAgo = twelve.toISOString().slice(0, 10);

  // --- who is in which lane -------------------------------------------------
  const laneById = new Map<number, LaneKey>();
  const laneByEmail = new Map<string, LaneKey>();
  for (const p of raw.prospects) {
    const l = laneOf(p, twelveAgo);
    if (!l) continue;
    laneById.set(p.id, l);
    if (p.email) laneByEmail.set(lc(p.email), l);
  }

  // --- sequences per lane ---------------------------------------------------
  const seqDoc: Record<LaneKey, SequenceDoc | null> = {
    warm: resolveSequence(shared, "warm:everyone"),
    offer: resolveSequence(shared, "offer:everyone"),
    wedding: resolveSequence(shared, "offer:wedding"),
    cold: resolveSequence(shared, "cold:everyone"),
  };
  const own = (tier: TierKey, cat: string) => seqSteps(resolveSequence(shared, `${tier}:${cat}`));
  const tier = (k: TierKey) => payload.tiers.find((t) => t.key === k)!;

  // The categories of each lane, with the steps each is counted against.
  type LaneCat = { cat: CategoryStat; steps: StepSpec[]; cadence: (typeof DEFAULT_CADENCE)[TierKey] };
  const laneCats: Record<LaneKey, LaneCat[]> = { warm: [], offer: [], wedding: [], cold: [] };
  const weddingSteps = seqSteps(seqDoc.wedding);
  for (const tk of ["cold", "warm", "offer"] as TierKey[]) {
    const everyone = seqSteps(resolveSequence(shared, `${tk}:everyone`));
    for (const cat of tier(tk).categories) {
      if (cat.hold) continue; // Personal cake: held out of every lane's email
      if (tk !== "cold" && cat.key === "wedding") {
        laneCats.wedding.push({ cat, steps: weddingSteps, cadence: "monthly" });
        continue;
      }
      const lane: LaneKey = tk;
      laneCats[lane].push({ cat, steps: categorySteps(cat.key, own(tk, cat.key), everyone), cadence: DEFAULT_CADENCE[tk] });
    }
  }

  // --- send history per prospect (all time, from the tab's loader) ----------
  const sendsByProspect = new Map<number, { template: string; at: string }[]>();
  for (const s of raw.sent) {
    if (!s.template) continue;
    const arr = sendsByProspect.get(s.prospect_id) ?? [];
    arr.push({ template: s.template, at: s.sent_at ?? "" });
    sendsByProspect.set(s.prospect_id, arr);
  }
  sendsByProspect.forEach((arr) => arr.sort((a, b) => a.at.localeCompare(b.at)));

  // A reply belongs to the step of the latest send before it.
  const stepOfTemplate = (lane: LaneKey, template: string): number | null => {
    const doc = seqDoc[lane];
    if (!doc) return null;
    const i = doc.steps.findIndex((s) => specKeys(stepSpec(s)).includes(template));
    return i < 0 ? null : i + 1;
  };

  // --- replies --------------------------------------------------------------
  const handledBy = new Map<number, string[]>();
  for (const o of extras.outcomes) {
    if (!HANDLED.has(o.event)) continue;
    const arr = handledBy.get(o.prospect_id) ?? [];
    arr.push(o.at);
    handledBy.set(o.prospect_id, arr);
  }
  const replies: ReplyFact[] = extras.outcomes
    .filter((o) => o.event === "replied")
    .map((o) => {
      const lane = laneById.get(o.prospect_id) ?? null;
      const prior = (sendsByProspect.get(o.prospect_id) ?? []).filter((s) => s.at <= o.at);
      const last = prior[prior.length - 1];
      const handled = (handledBy.get(o.prospect_id) ?? []).filter((t) => t >= o.at).sort()[0] ?? null;
      return {
        id: `r${o.id}`,
        lane,
        step: lane && last ? stepOfTemplate(lane, last.template) : null,
        at: o.at,
        handledAt: handled,
      };
    });

  // --- mailboxes and domains ------------------------------------------------
  const sorted = [...extras.mailboxes].sort((a, b) => a.address.localeCompare(b.address));
  const domainNames = Array.from(new Set(sorted.map((m) => m.address.split("@")[1] ?? ""))).sort((a, b) => {
    // Warm domains first, then cold.
    const ca = a.includes("benjerryphilly") ? 0 : 1;
    const cb = b.includes("benjerryphilly") ? 0 : 1;
    return ca - cb || a.length - b.length || a.localeCompare(b);
  });
  const domainId = new Map(domainNames.map((d, i) => [d, `d${i + 1}`]));
  const mailboxId = new Map<string, string>();
  // Ids follow screen order: by domain, then address.
  let mi = 0;
  for (const d of domainNames)
    for (const m of sorted.filter((x) => x.address.endsWith(`@${d}`))) mailboxId.set(m.address, `m${++mi}`);

  const days14: string[] = [];
  for (let i = 13; i >= 0; i--) days14.push(etDay(new Date(nowMs - i * DAY)));
  const day14Set = new Set(days14);

  const mailboxes: MailboxFact[] = [];
  for (const d of domainNames) {
    for (const m of sorted.filter((x) => x.address.endsWith(`@${d}`))) {
      const isCold = !d.includes("benjerryphilly");
      const mine = extras.sends.filter((s) => lc(s.mailbox) === lc(m.address));
      const realSends = mine.filter((s) => !s.apollo);
      const byDay = new Map<string, number>();
      for (const s of realSends) {
        const day = etDay(s.at);
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
      }
      const series = days14.map((day) => ({ day, n: byDay.get(day) ?? 0 }));
      // Normal band: the min and max of the last 10 weekdays it sent on, today left out.
      const past = series.filter((x) => x.day !== today && x.n > 0).slice(-10).map((x) => x.n);
      const band: [number, number] | null = past.length >= 3 ? [Math.min(...past), Math.max(...past)] : null;
      const bounces = extras.outcomes.filter((o) => o.event === "bounced" && lc(o.mailbox) === lc(m.address));
      const lanesUsing = new Map<LaneKey, number>();
      for (const s of mine) {
        if (!day14Set.has(etDay(s.at))) continue;
        const l = laneById.get(s.prospect_id);
        if (l) lanesUsing.set(l, (lanesUsing.get(l) ?? 0) + 1);
      }
      const cap = m.daily_allowance + (isCold ? 0 : (m.wedding_daily_allowance ?? 0));
      const prev7 = series.slice(-8, -1).reduce((s, x) => s + x.n, 0);
      mailboxes.push({
        id: mailboxId.get(m.address)!,
        address: m.address,
        short: m.address.split("@")[0] + "@",
        domainId: domainId.get(d)!,
        lane: isCold ? "cold" : "warm",
        cap,
        weddingCap: isCold ? 0 : (m.wedding_daily_allowance ?? 0),
        capNote: isCold
          ? `${m.daily_allowance}/day in outreach_mailboxes (Apollo sends it; Apollo's own setting is not read here)`
          : m.wedding_daily_allowance
            ? `${m.daily_allowance}/day warm + ${m.wedding_daily_allowance}/day wedding (outreach_mailboxes)`
            : `${m.daily_allowance}/day (outreach_mailboxes)`,
        sentToday: isCold ? null : (byDay.get(today) ?? 0),
        sentPrev7: isCold ? null : prev7,
        band: isCold ? null : band,
        days14: isCold ? null : series,
        bouncesToday: bounces.filter((b) => etDay(b.at) === today).length,
        bounces14: bounces.filter((b) => day14Set.has(etDay(b.at))).length,
        sends14: isCold ? null : series.reduce((s, x) => s + x.n, 0),
        frozen: m.frozen,
        frozenReason: m.frozen_reason,
        frozenAt: m.frozen_at,
        frozenBy: !m.frozen ? null : lc(m.frozen_reason).startsWith("governor") ? "rules" : "person",
        ration: m.unverified_ration !== null ? { n: m.unverified_ration, at: m.unverified_ration_at } : null,
        lanesUsing: Array.from(lanesUsing, ([lane, sent14]) => ({ lane, sent14 })).sort((a, b) => b.sent14 - a.sent14),
      });
    }
  }
  const bouncesNoMailbox14 = extras.outcomes.filter((o) => o.event === "bounced" && !o.mailbox && day14Set.has(etDay(o.at))).length;

  const domains: DomainFact[] = domainNames.map((d) => ({
    id: domainId.get(d)!,
    domain: d,
    lane: d.includes("benjerryphilly") ? "warm" : "cold",
    mailboxIds: mailboxes.filter((m) => m.domainId === domainId.get(d)).map((m) => m.id),
    // Nothing records seed tests or blocklist checks yet (spec 9.14: the
    // checks table round 1 proposed). Until it exists: No data.
    checks: [
      { kind: "seed", label: "Seed", everyDays: SEED_EVERY_DAYS, nodata: true, lastRunAt: null, result: null },
      { kind: "blocklist", label: "Blocklist", everyDays: BLOCKLIST_EVERY_DAYS, nodata: true, lastRunAt: null, result: null },
    ],
  }));

  // --- week -----------------------------------------------------------------
  const ago = (iso: string | null) => (iso ? (nowMs - new Date(iso).getTime()) / DAY : Infinity);
  const weekLane: Record<LaneKey, { replies: number; quotes: number; bookings: number }> = {
    warm: { replies: 0, quotes: 0, bookings: 0 },
    offer: { replies: 0, quotes: 0, bookings: 0 },
    wedding: { replies: 0, quotes: 0, bookings: 0 },
    cold: { replies: 0, quotes: 0, bookings: 0 },
  };
  let rep7 = 0;
  let rep28 = 0;
  for (const r of replies) {
    const a = ago(r.at);
    if (a < 7) {
      rep7++;
      if (r.lane) weekLane[r.lane].replies++;
    } else if (a < 35) rep28++;
  }
  let q7 = 0, q28 = 0, b7 = 0, b28 = 0, q7none = 0, b7none = 0;
  for (const d of raw.deals) {
    const created = parseNaiveUtc(d.created_at);
    if (!created) continue;
    const a = (nowMs - created.getTime()) / DAY;
    if (a >= 35 || a < 0) continue;
    const isQ = QUOTE_STAGES.has(d.stage ?? "");
    const isB = BOOKED_STAGES.has(d.stage ?? "");
    const lane = laneByEmail.get(lc(d.contact_email));
    if (a < 7) {
      if (lane) {
        if (isQ) { q7++; weekLane[lane].quotes++; }
        if (isB) { b7++; weekLane[lane].bookings++; }
      } else {
        if (isQ) q7none++;
        if (isB) b7none++;
      }
    } else if (lane) {
      if (isQ) q28++;
      if (isB) b28++;
    }
  }

  // --- lanes ----------------------------------------------------------------
  const lanes: LaneFact[] = LANE_KEYS.map((key) => {
    const cats = laneCats[key];
    const heldBy: Record<HeldReason, number> = { blocked: 0, finished: 0, noSequence: 0, moved: 0, notWritten: 0 };
    let upNext = 0, emailed = 0, held = 0, heldStale = 0;
    for (const lc_ of cats) {
      const st = statesAt(lc_.cat, lc_.cadence, () => lc_.steps);
      upNext += st.upNext;
      emailed += st.emailed;
      held += st.held;
      (Object.keys(heldBy) as HeldReason[]).forEach((r) => (heldBy[r] += st.heldBy[r]));
      for (const g of lc_.cat.groups) {
        const s = groupStanding(g, lc_.steps);
        if (s === "noSequence" || s === "moved")
          heldStale += g.never + g.ages.filter((a) => a >= HELD_STALE_DAYS).length;
      }
    }
    const doc = seqDoc[key];
    const specs = seqSteps(doc);
    const steps: StepFact[] = specs.map((spec, i) => {
      const keys = specKeys(spec);
      const step = doc!.steps[i];
      let sent: number | null = 0;
      if (key === "cold") sent = null;
      else
        for (const s of raw.sent)
          if (s.template && keys.includes(s.template) && laneById.get(s.prospect_id) === key) sent!++;
      const replied = replies.filter((r) => r.lane === key && r.step === i + 1).length;
      let engagement: Engagement | null = null;
      for (const c of cats) {
        const e = stepEngagement(c.cat, keys);
        if (!e) continue;
        engagement ??= { tracked: 0, opened: 0, clicked: 0 };
        engagement.tracked += e.tracked;
        engagement.opened += e.opened;
        engagement.clicked += e.clicked;
      }
      // Who is at this step next.
      let reached = 0, soon = 0, later = 0, maxAge = -1;
      for (const c of cats)
        for (const g of c.cat.groups) {
          const st = groupStanding(g, c.steps);
          if (st !== "open" && st !== "waiting") continue;
          const next = c.steps.findIndex((s) => !specKeys(s).some((k) => g.received.includes(k)));
          if (next !== i) continue;
          reached += g.never + g.ages.length;
          if (isUnwritten(spec)) {
            for (const a of g.ages) {
              if (a >= step.waitDays - COPY_DUE_WARN_DAYS) {
                soon++;
                maxAge = Math.max(maxAge, a);
              } else later++;
            }
          }
        }
      const firstDue =
        isUnwritten(spec) && soon > 0 ? new Date(nowMs + Math.max(0, step.waitDays - maxAge) * DAY).toISOString() : null;
      return {
        n: i + 1,
        label: step.subject.trim() ? shortLabel(step.subject) : `Step ${i + 1}`,
        written: !isUnwritten(spec),
        waitDays: step.waitDays,
        keys,
        sent,
        replied,
        engagement,
        reached,
        due: isUnwritten(spec) ? { soon, later, firstDue } : null,
      };
    });

    const laneMailboxes = mailboxes.filter((m) =>
      key === "cold" ? m.lane === "cold" : key === "wedding" ? m.weddingCap > 0 : key === "warm" ? m.lane === "warm" : false,
    );
    let status: LaneFact["status"] = "running";
    let statusNote: string | null = null;
    let pausedSince: string | null = null;
    if (key === "offer") {
      status = "nolane";
      statusNote = "no sender yet: offer contacts other than weddings are not emailed";
    } else if (laneMailboxes.length && laneMailboxes.every((m) => m.frozen)) {
      status = "paused";
      pausedSince = laneMailboxes.map((m) => m.frozenAt ?? "").filter(Boolean).sort()[0] ?? null;
      statusNote = "every mailbox stopped";
    }
    return {
      key,
      label: LANE_LABEL[key],
      who: LANE_WHO[key],
      status,
      statusNote,
      pausedSince,
      upNext,
      emailed,
      held,
      heldBy,
      heldStale,
      steps,
      sequenceName: doc?.name ?? null,
      mailboxIds: laneMailboxes.map((m) => m.id),
      week: weekLane[key],
      waitingOn: laneMailboxes.filter((m) => m.frozen).map((m) => ({ mailboxId: m.id, n: null })),
    };
  });

  // --- ticks: the last two hours -------------------------------------------
  const ticks: Facts["ticks"] = [];
  for (const s of extras.sends) if (!s.apollo && nowMs - new Date(s.at).getTime() < 2 * 3_600_000) ticks.push({ at: s.at, kind: "send" });
  for (const r of replies) if (nowMs - new Date(r.at).getTime() < 2 * 3_600_000) ticks.push({ at: r.at, kind: "reply" });

  // --- MEMO: overrides still in effect --------------------------------------
  const memo: MemoFact[] = [];
  for (const m of mailboxes) {
    if (m.ration)
      memo.push({
        id: `ration:${m.id}`,
        text: `${m.short} unverified sends rationed to ${m.ration.n}/day`,
        who: "who set it is not recorded",
        since: m.ration.at,
        ends: null,
      });
    if (m.frozen && m.frozenBy === "person")
      memo.push({ id: `pause:${m.id}`, text: `${m.short} paused by hand`, who: m.frozenReason ?? "", since: m.frozenAt, ends: null });
  }

  return {
    now: now.toISOString(),
    today,
    lanes,
    mailboxes,
    domains,
    replies,
    week: {
      replies: { n: rep7, avg4: rep28 / 4 },
      quotes: { n: q7, avg4: q28 / 4 },
      bookings: { n: b7, avg4: b28 / 4 },
      notFromEmail: { quotes: q7none, bookings: b7none },
    },
    ticks,
    memo,
    bouncesNoMailbox14,
    notes: [],
  };
}

function shortLabel(subject: string): string {
  const s = subject.replace(/\{[^}]*\}/g, "…").trim();
  return s.length > 22 ? s.slice(0, 21) + "…" : s;
}

/** Is it a sending weekday afternoon in New York (for the silence rule)? */
export function sendingAfternoon(now: Date, hour = 12): boolean {
  return isWeekday(now) && etParts(now).hour >= hour;
}
