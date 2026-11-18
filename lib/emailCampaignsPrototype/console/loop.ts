// PROTOTYPE (bj-finance #811 round 3, #964), throwaway. The weekly email
// loop as the console sees it: types, words and the loop's bubble-up rules
// (spec 10.4, L1 to L8). Pure functions. The live tables are read and turned
// into these facts in loopLive.ts; the synthetic week is loopSynthetic.ts.

import type { AttentionItem } from "./attention";
import { dateEt, etDay, etParts, isWeekday } from "./time";

export type Tier = "warm" | "cold" | "offer";

/** Scorer rate block: a rate per 1,000 with its 90% range (Wilson). */
export type RateFact = { k: number; n: number; per1000: number | null; lo: number | null; hi: number | null };

export type ApproachFact = {
  id: string;
  name: string;
  family: string;
  opener: string;
  structure: string;
  ask: string;
  length: "short" | "medium" | "long";
  baseline: boolean;
  brief: string;
  createdBy: string;
  createdAt: string;
  /** Round 4: where the idea came from. "human" is an email people sent
   * before the loop (its sends are the starting data); "research" came from
   * Alina's reading; "loop" is the loop's own idea. */
  origin: "human" | "research" | "loop";
  /** What it is meant to change in the reader. */
  purpose: string;
  /** Why it was started, in a sentence. */
  whyTried: string;
  /** What the rest of the email has to do so the whole reads as one. */
  fitsWith: string;
  /** What result would mean it is not working. */
  stopIf: string;
  evidence: EvidenceFact[];
  /** Only sent in these send-time slots (empty: any). */
  slots: string[];
  /** Its emails send only once a person approved it (021). Null: waiting. */
  approvedAt?: string | null;
  approvedBy?: string | null;
};

export type EvidenceFact = { source: string; url: string | null; finding: string };

export type Verdict = "baseline" | "learning" | "live" | "retire" | "crown";

export type ArmFact = {
  approachId: string;
  status: "live" | "retired" | "crowned";
  since: string;
  reason: string;
  sends: number;
  reply: RateFact;
  lead: RateFact;
  booking: RateFact;
  /** Chance of being best on replies, 0..1 (round 4: replies come about
   * three times as often as leads, so they decide about three times as fast;
   * a reply winner must not trail on leads). Null before any send. */
  best: number | null;
  verdict: Verdict;
  emailsThisWeek: number;
};

export type OccasionFact = { id: string; name: string; aim: string; basis: string };

export type TypeFact = {
  key: string;
  tier: Tier;
  label: string;
  target: OccasionFact | null;
  upcoming: OccasionFact[];
  emailsThisWeek: number;
  sentThisWeek: number;
  ready: number;
  held: { reason: string; n: number }[];
  /** Emailed, but with a changed ask. Empty since 2026-11-16: small groups are not emailed. */
  adjusted: { reason: string; n: number }[];
  /** Per-type reads of each approach: diagnostic only, too few to decide. */
  arms: ArmFact[];
  /** The approach most of this week's emails use. */
  mostly: string | null;
};

/** Round 4: one question at a time, pooled across every type it fits. */
export type TestFact = {
  id: string;
  tier: Tier | "all";
  factor: "approach" | "send time";
  question: string;
  /** Pooled arms; for a send-time test, approachId is the slot id. */
  arms: ArmFact[];
  weekly: number;
  started: string;
  why: string;
};

export type SlotFact = { id: string; label: string; at: string; why: string; evidence: EvidenceFact[] };

/** What people sent before the loop: its starting data (round 4). */
export type HistoryFact = {
  id: string;
  name: string;
  lane: string;
  sent: number | null;
  replied: number | null;
  deals: number | null;
  booked: number | null;
  status: "baseline" | "in the loop" | "retired";
  becomes: string;
  synthetic?: string;
};

export type DraftFact = {
  id: string;
  sendOn: string;
  touch: number;
  planned: number;
  type: string;
  approachId: string;
  assignedBy: "baseline_quota" | "thompson";
  subject: string;
  body: string;
  status: "planned" | "sent" | "skipped" | "held";
  skipReason: string | null;
  mailbox: string;
  person: { name: string; company: string; email: string };
  why: {
    relationship: string;
    occasion: string | null;
    eventDate: string;
    basis: "known" | "estimated" | "occasion";
    source: string;
    confidence: number | null;
    evidence: string | null;
  };
  prior: { touch: number; subject: string; sentOn: string }[];
  /** Round 4: when it lands (a slot of the send-time test), as ISO. */
  slot: string;
  sendAt: string;
  /** Round 4: the judge read the whole email before it was planned. */
  judge: { verdict: "pass" | "rewritten" | "held"; note: string };
  /** Why this approach for this person, in a sentence. */
  pick: string;
  /** Planned, but its approach is not approved yet, so it waits. */
  waitingApproval?: boolean;
  /** When it went out (live data only). */
  sentAt?: string | null;
  /** Held from the console: who, when and why (022). */
  held?: { at: string; by: string; reason: string } | null;
};

export type DecisionFact = { kind: "add" | "retire" | "crown" | "reopen" | "hold"; type: string | null; approachId: string; reason: string };
export type AskFact = { id: string; text: string; answered: boolean };

export type RunFact = {
  weekStart: string;
  createdAt: string;
  check: { ok: boolean; text: string };
  memo: string;
  decisions: DecisionFact[];
  asks: AskFact[];
  approvedAt: string | null;
  digestSentAt: string | null;
  planned: number;
};

export type EstimateFact = {
  company: string;
  kind: string;
  date: string;
  source: "public" | "linkedin" | "job_change";
  confidence: number;
  evidenceUrl: string;
  evidence: string;
  foundAt: string;
};

export type LimitsFact = {
  dailyCap: number;
  baselineShare: number;
  maxLive: number;
  coldEnabled: boolean;
  apolloCredits: number;
  unsubPause: number;
  minGuests: number;
  holdBackMonths: number;
  minDaysBeforeEvent: number;
  /** Round 4: hard lines, never crossed. */
  never: string[];
  /** Round 4: suggestions. The loop may go past one when it has a reason, and says why. */
  leanToward: string[];
  coldDailyCap: number;
  allowedOffers: string[];
  approvedAsk: string[];
  linkedinCap: number;
  linkedinPause: number;
  neverEmail: number;
};

export type NoteFact = { name: string; company: string; why: string; since: string; noteSentAt: string | null };

export type LoopFacts = {
  /** Set when any of this is not real data. */
  synthetic?: string;
  /** Set when the loop could not be read at all, in words. */
  unavailable?: string;
  /** False when the run did not record the limits it ran under. */
  limitsRecorded?: boolean;
  /** Approaches whose planned emails wait for approval, with how many. */
  approvals?: { approachId: string; n: number }[];
  now: string;
  today: string;
  weekStart: string;
  gate: boolean;
  paused: { since: string; by: string; why: string } | null;
  run: RunFact | null;
  runs: RunFact[];
  types: TypeFact[];
  cold: { enabled: boolean; ready: number };
  tests: TestFact[];
  slots: Record<string, SlotFact>;
  history: HistoryFact[];
  judge: { passed: number; rewritten: number; held: number; youOverruled: number };
  approaches: Record<string, ApproachFact>;
  drafts: DraftFact[];
  limits: LimitsFact;
  research: {
    viewsToday: number;
    halt: { at: string; note: string } | null;
    estimates: EstimateFact[];
    accuracy: { source: string; checked: number; medianDaysOff: number | null }[];
  };
  notes: NoteFact[];
  volume: { ready: number; roomPerWeek: number; warm: { ready: number; room: number }; cold: { ready: number; room: number } };
  unsub: { n: number; sends: number };
  week: { replies: number; leads: number; bookings: number; avg4: { replies: number; leads: number; bookings: number } };
  flagged: { draftId: string; words: string | null }[];
};

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const TYPE_WORDS: Record<string, string> = {
  office_manager: "Office managers",
  exec_admin: "Executive assistants",
  hr_people_ops: "HR and people teams",
  corporate_events: "Corporate event planners",
  law_admin: "Law firm admins",
  healthcare_practice: "Medical practices",
  property_mgmt: "Property managers",
  coworking: "Coworking spaces",
  education: "Schools and universities",
  nonprofit_events: "Nonprofits",
  wedding: "Couples",
  wedding_trade: "Wedding planners",
  unknown: "Unlabelled",
  uncategorised: "Not sorted yet",
  // Past customers and enquirers, by what they booked or asked about.
  corporate: "Companies",
  school: "Schools",
  community: "Community groups",
  family: "Families",
  no_deal: "Enquired, never booked",
  past_booker: "Booked before",
  other: "Everyone else",
};

export const typeLabel = (key: string) => TYPE_WORDS[key.split(":")[1] ?? key] ?? key;
export const tierOf = (key: string): Tier => (key.split(":")[0] as Tier) ?? "warm";
export const TIER_WORD: Record<Tier, string> = { warm: "Past customers and enquirers", cold: "New to us (cold)", offer: "Offer" };

export const VERDICT_WORD: Record<Verdict, string> = {
  baseline: "baseline, never retired",
  learning: `too early (under ${5} replies)`,
  live: "still competing",
  retire: "due to retire (under 5% chance of best)",
  crown: "due to win (over 95% chance of best)",
};

export const SOURCE_WORD: Record<string, string> = {
  booking: "their booking with us",
  enquiry: "their enquiry",
  public: "a public page",
  linkedin: "LinkedIn",
  job_change: "a job change",
  occasion_calendar: "the occasion calendar",
};

/** Under this many replies an approach's range spans more than three times
 * its rate, so it is drawn gray and judged by nothing (round 4: replaces the
 * round 3 placeholder of 150 sends, which was not derived from anything). */
export const EARLY_REPLIES = 5;
export const isEarly = (a: ArmFact) => a.reply.k < EARLY_REPLIES;

/**
 * Weeks until the first challenger can be called, if it is twice as good as
 * the baseline on replies (one-sided 95%, 80% power). When the baseline
 * carries a long history (1,000+ sends) its rate counts as known and a
 * challenger needs about a quarter of the emails a two-arm test would.
 * Null when no challenger is live; Infinity when the volume never gets there.
 */
export function weeksToDecide(t: TestFact, baselineShare: number): number | null {
  const base = t.arms.find((a) => a.verdict === "baseline");
  const challengers = t.arms.filter((a) => a.status === "live" && a.verdict !== "baseline");
  if (!base || !challengers.length) return null;
  const p0 = Math.max(base.reply.k, 1) / Math.max(base.reply.n, 1);
  const p1 = Math.min(2 * p0, 0.99);
  const za = 1.645;
  const zb = 0.84;
  const need =
    base.reply.n >= 1000
      ? (za * Math.sqrt(p0 * (1 - p0)) + zb * Math.sqrt(p1 * (1 - p1))) ** 2 / (p1 - p0) ** 2
      : ((za + zb) ** 2 * (p0 * (1 - p0) + p1 * (1 - p1))) / (p1 - p0) ** 2;
  const perArm = (t.weekly * (1 - baselineShare)) / challengers.length;
  if (perArm <= 0) return Infinity;
  const left = Math.min(...challengers.map((a) => Math.max(0, need - a.sends)));
  return left / perArm;
}

export const weeksWord = (w: number | null) =>
  w === null ? "nothing to decide" : w === 0 ? "ready to call" : w > 26 ? "not this season" : `about ${Math.max(1, Math.round(w))} week${Math.round(w) > 1 ? "s" : ""}`;

/** Wilson 90% range per 1,000, as scorer.py computes it. */
export function rate(k: number, n: number): RateFact {
  if (n === 0) return { k, n, per1000: null, lo: null, hi: null };
  const z = 1.645;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { k, n, per1000: r(1000 * p), lo: r(1000 * Math.max(centre - half, 0)), hi: r(1000 * Math.min(centre + half, 1)) };
}

// ---------------------------------------------------------------------------
// Bubble-up rules L1 to L8 (spec 10.4)
// ---------------------------------------------------------------------------

const RUN_DUE_HOUR = 9; // L1: red at 9am Monday ET (spec 10.6 question 3)
const SENDER_DUE_HOUR = 14; // L3: due emails still planned at 2pm
const NOTE_DAYS = 7; // L7

function item(x: Omit<AttentionItem, "stale" | "affects" | "openedAt"> & { openedAt?: string | null; affects?: AttentionItem["affects"] }): AttentionItem {
  return { stale: false, affects: [], openedAt: null, ...x };
}

export function loopItems(L: LoopFacts): AttentionItem[] {
  const now = new Date(L.now);
  const et = etParts(now);
  const out: AttentionItem[] = [];
  const tag = L.synthetic;

  // L1 Monday run missing or stopped at its check.
  const runDue = L.today > L.weekStart || (L.today === L.weekStart && et.hour >= RUN_DUE_HOUR);
  if (L.run && !L.run.check.ok)
    out.push(
      item({
        id: "loop:run",
        rule: "loop_run_missing",
        level: "warning",
        area: "Loop",
        path: ["loop", "week"],
        pathLabel: "Loop › This week",
        home: { kind: "panel", panel: "week" },
        title: "Weekly run stopped at its check",
        detail: `${L.run.check.text} Nothing is planned for this week, so nothing sends.`,
        openedAt: L.run.createdAt,
        fixes: ["Open the week"],
        synthetic: tag,
      }),
    );
  else if (!L.run && runDue)
    out.push(
      item({
        id: "loop:run",
        rule: "loop_run_missing",
        level: "warning",
        area: "Loop",
        path: ["loop", "week"],
        pathLabel: "Loop › This week",
        home: { kind: "panel", panel: "week" },
        title: `No weekly run for the week of ${dateEt(`${L.weekStart}T17:00:00Z`)}`,
        detail: "The weekly run has not logged this week. Sends wait for a run, so nothing new goes out.",
        fixes: ["Open the week"],
        synthetic: tag,
      }),
    );

  // L2 Week waiting for approval (review gate on).
  const planned = L.drafts.filter((d) => d.status === "planned");
  if (L.run?.check.ok && L.gate && !L.run.approvedAt && planned.length) {
    const first = planned.map((d) => d.sendOn).sort()[0];
    const sendsToday = first <= L.today;
    out.push(
      item({
        id: "loop:approve",
        rule: "loop_week_approval",
        level: sendsToday ? "warning" : "caution",
        area: "Loop",
        path: ["loop", "emails"],
        pathLabel: "Loop › Emails this week",
        home: { kind: "panel", panel: "emails" },
        title: `${planned.length} emails waiting for your approval`,
        detail: sendsToday
          ? `The first were due ${first === L.today ? "today" : dateEt(`${first}T17:00:00Z`)}. Nothing sends until you approve the week.`
          : `The first go out ${dateEt(`${first}T17:00:00Z`)}. Nothing sends until you approve the week.`,
        openedAt: L.run.createdAt,
        fixes: ["Read and approve the week"],
        synthetic: tag,
      }),
    );
  }

  // L2b Approaches waiting for approval (021): their emails do not send.
  for (const a of L.approvals ?? []) {
    const name = L.approaches[a.approachId]?.name ?? a.approachId;
    out.push(
      item({
        id: `loop:approve:${a.approachId}`,
        rule: "loop_week_approval",
        level: "caution",
        area: "Loop",
        path: ["loop", `approach:${a.approachId}`],
        pathLabel: `Loop › Approaches › ${name}`,
        home: { kind: "panel", panel: `approach:${a.approachId}` },
        title: `${a.n} email${a.n === 1 ? "" : "s"} wait for your approval of “${name}”`,
        detail: "A new approach sends nothing until you approve it. Read a few of its emails, then approve it or leave it waiting.",
        fixes: ["Read and approve"],
        synthetic: tag,
      }),
    );
  }

  // L3 Sender did not send. With live data, only when nothing at all went
  // out today: emails still waiting while others went out is volume (L3b).
  const approved = !L.gate || !!L.run?.approvedAt;
  const knowsSends = L.drafts.some((d) => d.sentAt !== undefined);
  const sentToday = L.drafts.filter((d) => d.status === "sent" && d.sentAt && etDay(new Date(d.sentAt)) === L.today).length;
  if (approved && !L.paused && isWeekday(now) && et.hour >= SENDER_DUE_HOUR && !(knowsSends && sentToday > 0)) {
    // The 3pm slot is not due until 3pm, so only earlier days count for it.
    const late = planned.filter((d) => !d.waitingApproval && (d.sendOn < L.today || (d.sendOn === L.today && d.slot !== "slump")));
    if (late.length)
      out.push(
        item({
          id: "loop:sender",
          rule: "loop_sender_silent",
          level: "warning",
          area: "Loop",
          path: ["loop", "emails"],
          pathLabel: "Loop › Emails this week",
          home: { kind: "panel", panel: "emails" },
          title: `Sender has sent nothing today: ${late.length} emails waiting`,
          detail: "The sender runs at 10:30, 11:40 and 3pm on weekdays. By 2pm some of today's emails should have gone out.",
          fixes: ["Open the emails"],
          synthetic: tag,
        }),
      );
  }

  // L3b More planned than the mailboxes can send by Friday.
  if (knowsSends && !L.paused && L.volume.roomPerWeek > 0) {
    const waiting = planned.filter((d) => !d.waitingApproval).length;
    const dow = et.weekday; // 0 Sunday .. 6 Saturday
    const daysLeft = dow === 0 || dow === 6 ? 5 : Math.max(0, 5 - dow + (et.hour < 15 ? 1 : 0));
    const room = Math.round((L.volume.roomPerWeek / 5) * daysLeft);
    if (waiting > room)
      out.push(
        item({
          id: "loop:backlog",
          rule: "loop_backlog",
          level: "caution",
          area: "Loop",
          path: ["loop", "week"],
          pathLabel: "Loop › This week",
          home: { kind: "panel", panel: "week" },
          title: `${waiting} emails waiting, room for about ${room} by Friday`,
          detail: `The run planned more than the mailboxes can send (${sentToday} went out today). The rest carry to next week; more mailboxes would clear it.`,
          fixes: ["Open the week"],
          synthetic: tag,
        }),
      );
  }

  // L4 LinkedIn halted.
  if (L.research.halt)
    out.push(
      item({
        id: "loop:research",
        rule: "loop_research_halted",
        level: "warning",
        area: "Loop",
        path: ["loop", "research"],
        pathLabel: "Loop › Research",
        home: { kind: "panel", panel: "research" },
        title: "LinkedIn research halted",
        detail: L.research.halt.note,
        openedAt: L.research.halt.at,
        fixes: ["Read the halt note"],
        synthetic: tag,
      }),
    );

  // L5 Unsubscribe pause.
  if (L.unsub.sends > 0 && L.unsub.n / L.unsub.sends > L.limits.unsubPause)
    out.push(
      item({
        id: "loop:unsub",
        rule: "loop_unsub_pause",
        level: "warning",
        area: "Loop",
        path: ["loop", "limits"],
        pathLabel: "Loop › Limits",
        home: { kind: "panel", panel: "limits" },
        title: `Loop paused: ${L.unsub.n} unsubscribes in ${L.unsub.sends} sends this week`,
        detail: `Over your limit of ${(L.limits.unsubPause * 100).toFixed(0)}%. The loop stays paused until you resume it.`,
        fixes: ["Read your limits"],
        synthetic: tag,
      }),
    );

  // L6 Asks from the Monday run.
  const asks = L.run?.asks.filter((a) => !a.answered) ?? [];
  if (asks.length)
    out.push(
      item({
        id: "loop:asks",
        rule: "loop_asks",
        level: "ready",
        area: "Loop",
        path: ["loop", "week"],
        pathLabel: "Loop › This week",
        home: { kind: "panel", panel: "week" },
        title: `The weekly run asks you ${asks.length} thing${asks.length > 1 ? "s" : ""}`,
        detail: asks.map((a) => a.text.split("?")[0] + "?").join(" "),
        openedAt: L.run?.createdAt ?? null,
        fixes: ["Read the asks"],
        synthetic: tag,
      }),
    );

  // L7 Personal notes owed.
  const owed = L.notes.filter((n) => !n.noteSentAt && (now.getTime() - new Date(n.since).getTime()) / 86_400_000 >= NOTE_DAYS);
  if (owed.length)
    out.push(
      item({
        id: "loop:notes",
        rule: "loop_notes_owed",
        level: "caution",
        area: "Loop",
        path: ["loop", "notes"],
        pathLabel: "Loop › Personal notes",
        home: { kind: "panel", panel: "notes" },
        title: `${owed.length} personal note${owed.length > 1 ? "s" : ""} owed`,
        detail: `${owed.map((n) => n.name).join(", ")}: a complaint or refund, so they get a note from you instead of a loop email.`,
        fixes: ["Open the notes"],
        synthetic: tag,
      }),
    );

  // L8 Flagged email waiting for its won't-say line.
  for (const fl of L.flagged.filter((x) => !x.words)) {
    const d = L.drafts.find((x) => x.id === fl.draftId);
    if (!d) continue;
    out.push(
      item({
        id: `loop:flag:${d.id}`,
        rule: "loop_flagged",
        level: "ready",
        area: "Loop",
        path: ["loop", "emails", d.id],
        pathLabel: `Loop › Emails › ${d.person.name}`,
        home: { kind: "panel", panel: "emails", sel: `email:${d.id}` },
        title: `Flagged email to ${d.person.name} needs your won't-say line`,
        detail: "You held this email. Say what it should never say and the loop opens a PR to your limits with your words.",
        fixes: ["Open the email"],
        synthetic: tag,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The loop's week
// ---------------------------------------------------------------------------

/** The Monday that starts the loop's current week: this week's Monday on a
 * weekday, the coming Monday at the weekend (the run plans the week ahead). */
export function loopWeekStart(now: Date): string {
  const p = etParts(now);
  const d = new Date(`${p.ymd}T12:00:00Z`);
  const dow = p.weekday; // 0 Sunday .. 6 Saturday
  const shift = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow;
  return new Date(d.getTime() + shift * 86_400_000).toISOString().slice(0, 10);
}

export const todayEt = (now: Date) => etDay(now);

// ---------------------------------------------------------------------------
// Round 4: chance of best, and the starting data from what people sent
// ---------------------------------------------------------------------------

/** Chance each live arm is best on replies: draws from each arm's Beta(1+k,
 * 1+n-k), normal approximation, seeded so the page is stable on reload. */
export function chanceBest(arms: ArmFact[], draws = 4000): void {
  // An arm with no sends has nothing to rank yet (a flat prior would win
  // half the draws); it shows as "new".
  const live = arms.filter((a) => a.status === "live" && a.reply.n > 0);
  for (const a of arms) if (a.status === "live" && a.reply.n === 0) a.best = null;
  let s = 1234567;
  const u = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 0.5) / 2 ** 32;
  };
  const z = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  const wins = live.map(() => 0);
  const par = live.map((a) => {
    const al = 1 + a.reply.k;
    const be = 1 + a.reply.n - a.reply.k;
    const m = al / (al + be);
    return { m, sd: Math.sqrt((al * be) / ((al + be) ** 2 * (al + be + 1))) };
  });
  for (let i = 0; i < draws; i++) {
    let best = -1;
    let at = 0;
    par.forEach((p, j) => {
      const x = p.m + p.sd * z();
      if (x > best) {
        best = x;
        at = j;
      }
    });
    wins[at]++;
  }
  live.forEach((a, j) => (a.best = Math.round((wins[j] / draws) * 100) / 100));
  for (const a of arms) if (a.status !== "live") a.best = 0;
}

export function verdictOf(a: ArmFact, baseline: boolean): Verdict {
  if (baseline) return "baseline";
  if (a.status === "retired") return "retire";
  if (isEarly(a)) return "learning";
  if (a.best !== null && a.best > 0.95) return "crown";
  if (a.best !== null && a.best < 0.05) return "retire";
  return "live";
}

/** The sales_lanes lanes that were emails people sent by hand, and what each
 * becomes in the loop. */
const HAND_RUN: { lane: string; id: string; name: string; status: HistoryFact["status"]; becomes: string }[] = [
  { lane: "warm", id: "holiday_letter", name: "Holiday letter", status: "baseline", becomes: "The baseline for past customers and enquirers: what every new first email has to beat." },
  { lane: "holiday gift", id: "holiday_gift", name: "$100 Holiday Gift", status: "in the loop", becomes: "An approach for past customers who booked, competing in the same test." },
  { lane: "cold", id: "cold_pilot_a", name: "Cold Pilot A", status: "baseline", becomes: "The baseline for new-to-us people." },
  { lane: "warm: wedding", id: "wedding_expo", name: "Wedding expo follow-up", status: "retired", becomes: "Retired: no more wedding emails. Its replies stay in the history." },
];

type SalesLaneLike = { lane: string; sinceStart: { sent: number | null; replied: number | null; deals: number | null; booked: number | null } };

/** Fold what people already sent into the loop: history rows, and the
 * baselines' and the folded approaches' pooled counts (round 4). */
export function withHistory(L: LoopFacts, lanes: SalesLaneLike[] | null, tag?: string): LoopFacts {
  if (!lanes) return { ...L, history: HAND_RUN.map((h) => ({ ...h, sent: null, replied: null, deals: null, booked: null, synthetic: "sales numbers not readable" })) };
  const history: HistoryFact[] = HAND_RUN.map((h) => {
    const s = lanes.find((x) => x.lane === h.lane)?.sinceStart;
    return { id: h.id, name: h.name, lane: h.lane, status: h.status, becomes: h.becomes, sent: s?.sent ?? null, replied: s?.replied ?? null, deals: s?.deals ?? null, booked: s?.booked ?? null, synthetic: tag };
  });
  const tests = L.tests.map((t) => {
    const arms = t.arms.map((a) => {
      const h = t.factor === "approach" ? history.find((x) => x.id === a.approachId) : undefined;
      if (!h || h.sent === null) return { ...a };
      const n = a.sends + h.sent;
      return {
        ...a,
        sends: n,
        reply: rate(a.reply.k + (h.replied ?? 0), n),
        lead: rate(a.lead.k + (h.deals ?? 0), n),
        booking: rate(a.booking.k + (h.booked ?? 0), n),
      };
    });
    chanceBest(arms);
    for (const a of arms) a.verdict = verdictOf(a, L.approaches[a.approachId]?.baseline ?? a.verdict === "baseline");
    return { ...t, arms };
  });
  return { ...L, history, tests };
}
