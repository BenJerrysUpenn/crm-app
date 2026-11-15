// PROTOTYPE (bj-finance #811 round 3, #964), throwaway. The weekly email
// loop as the console sees it: types, the real reader, and the loop's
// bubble-up rules (spec 10.4, L1 to L8). Pure functions apart from the reader.
// Read only: the reader uses the signed-in manager's client, like load.ts.
//
// The loop tables have row security on and no read policy yet (spec 10.5),
// and nothing has run live, so the reader returns "unreadable" or "empty"
// today and the page shows the synthetic week (loopSynthetic.ts) instead.

import type { SupabaseClient } from "@supabase/supabase-js";
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
};

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
  /** Chance of being best on leads, 0..1. Null before any send. */
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
  arms: ArmFact[];
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
  willSay: string[];
  wontSay: string[];
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
  now: string;
  today: string;
  weekStart: string;
  gate: boolean;
  paused: { since: string; by: string; why: string } | null;
  run: RunFact | null;
  runs: RunFact[];
  types: TypeFact[];
  cold: { enabled: boolean; ready: number };
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
  volume: { ready: number; roomPerWeek: number };
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
};

export const typeLabel = (key: string) => TYPE_WORDS[key.split(":")[1] ?? key] ?? key;
export const tierOf = (key: string): Tier => (key.split(":")[0] as Tier) ?? "warm";
export const TIER_WORD: Record<Tier, string> = { warm: "Warm", cold: "Cold", offer: "Offer" };

export const VERDICT_WORD: Record<Verdict, string> = {
  baseline: "baseline, never retired",
  learning: "too early (under 150 sends)",
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

export const MIN_SENDS_FOR_VERDICT = 150;

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
        fixes: ["Open the run log"],
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
        fixes: ["Open the run log"],
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

  // L3 Sender did not send.
  const approved = !L.gate || !!L.run?.approvedAt;
  if (approved && !L.paused && isWeekday(now) && et.hour >= SENDER_DUE_HOUR) {
    const late = planned.filter((d) => d.sendOn <= L.today);
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
          title: `Sender did not send: ${late.length} emails due today still waiting`,
          detail: "The daily sender runs at 10am. By 2pm every email due today should be sent or skipped with a reason.",
          fixes: ["Open the sender log"],
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
        fixes: ["Read the memo", "Resume"],
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
        fixes: ["Answer each ask"],
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
        fixes: ["Write the note"],
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
        fixes: ["Write the line"],
        synthetic: tag,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The real reader (read only, signed-in manager)
// ---------------------------------------------------------------------------

export type LoopInputs =
  | { status: "unreadable"; message: string }
  | { status: "empty" }
  | { status: "read"; rows: LoopRows };

export type LoopRows = {
  runs: { week_start: string; created_at: string; memo: string; decisions: unknown; score: unknown; digest_sent_at: string | null }[];
  arms: { customer_type: string; approach_id: string; status: ArmFact["status"]; since: string; reason: string }[];
  approaches: { id: string; family: string; opener: string; structure: string; ask_type: string; length_band: ApproachFact["length"]; is_baseline: boolean; brief: string; created_by: string; created_at: string }[];
  drafts: { id: number; sequence_id: number; prospect_id: number; touch: number; send_on: string; customer_type: string; approach_id: string; assigned_by: DraftFact["assignedBy"]; subject: string; body: string; status: "planned" | "sent" | "skipped"; skip_reason: string | null }[];
  sequences: { id: number; occasion_id: string | null; event_date: string; date_basis: DraftFact["why"]["basis"]; date_source: string; date_confidence: number | null; planned_steps: number }[];
};

export async function loadLoop(supabase: SupabaseClient, weekStart: string): Promise<LoopInputs> {
  const runs = await supabase
    .from("outreach_loop_runs")
    .select("week_start,created_at,memo,decisions,score,digest_sent_at")
    .order("week_start", { ascending: false })
    .limit(12);
  if (runs.error) return { status: "unreadable", message: runs.error.message };
  if (!runs.data?.length) return { status: "empty" };
  const weekEnd = new Date(new Date(`${weekStart}T12:00:00Z`).getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const [arms, approaches, drafts, sequences] = await Promise.all([
    supabase.from("outreach_loop_arms").select("customer_type,approach_id,status,since,reason"),
    supabase.from("outreach_loop_approaches").select("id,family,opener,structure,ask_type,length_band,is_baseline,brief,created_by,created_at"),
    supabase
      .from("outreach_loop_drafts")
      .select("id,sequence_id,prospect_id,touch,send_on,customer_type,approach_id,assigned_by,subject,body,status,skip_reason")
      .gte("send_on", weekStart)
      .lt("send_on", weekEnd)
      .order("send_on"),
    supabase
      .from("outreach_loop_sequences")
      .select("id,occasion_id,event_date,date_basis,date_source,date_confidence,planned_steps")
      .eq("status", "live"),
  ]);
  const err = arms.error ?? approaches.error ?? drafts.error ?? sequences.error;
  if (err) return { status: "unreadable", message: err.message };
  return {
    status: "read",
    rows: {
      runs: runs.data as LoopRows["runs"],
      arms: (arms.data ?? []) as LoopRows["arms"],
      approaches: (approaches.data ?? []) as LoopRows["approaches"],
      drafts: (drafts.data ?? []) as LoopRows["drafts"],
      sequences: (sequences.data ?? []) as LoopRows["sequences"],
    },
  };
}

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

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

function rateOf(block: unknown): RateFact {
  const b = obj(block);
  const nums = obj(b.numbers);
  const range = arr(b.range) as number[];
  return {
    k: Number(nums.successes ?? 0),
    n: Number(nums.sends ?? 0),
    per1000: typeof b.per_1000 === "number" ? b.per_1000 : null,
    lo: typeof range[0] === "number" ? range[0] : null,
    hi: typeof range[1] === "number" ? range[1] : null,
  };
}

function runOf(r: LoopRows["runs"][number], planned: number): RunFact {
  const d = obj(r.decisions);
  const pairs = (key: string, kind: DecisionFact["kind"]) =>
    arr(d[key]).map((x) => {
      const [type, approachId, reason] = arr(x) as string[];
      return { kind, type: type ?? null, approachId: approachId ?? "", reason: reason ?? "" };
    });
  const added = arr(d.new_approaches).map((x) => {
    const a = obj(x);
    return { kind: "add" as const, type: (arr(a.customer_types)[0] as string) ?? null, approachId: String(a.id ?? ""), reason: String(a.brief ?? "") };
  });
  return {
    weekStart: r.week_start,
    createdAt: r.created_at,
    check: { ok: true, text: "The run logged, so its startup check passed." },
    memo: r.memo,
    decisions: [...added, ...pairs("retire", "retire"), ...pairs("reopen", "reopen")],
    asks: arr(d.asks).map((x, i) => ({ id: String(i), text: String(x), answered: false })),
    approvedAt: null,
    digestSentAt: r.digest_sent_at,
    planned,
  };
}

/** Real loop rows into facts. Limits, occasions, research, notes and volume
 * are not in the database yet (spec 10.5): `fill` supplies them, marked. */
export function buildLoop(
  rows: LoopRows,
  people: Map<number, { name: string | null; company: string | null; email: string | null }>,
  now: Date,
  fill: LoopFacts,
): LoopFacts {
  const weekStart = loopWeekStart(now);
  const today = todayEt(now);
  const thisRun = rows.runs.find((r) => r.week_start === weekStart) ?? null;
  const seq = new Map(rows.sequences.map((s) => [s.id, s]));
  const drafts: DraftFact[] = rows.drafts.map((d) => {
    const p = people.get(d.prospect_id);
    const s = seq.get(d.sequence_id);
    return {
      id: String(d.id),
      sendOn: d.send_on,
      touch: d.touch,
      planned: s?.planned_steps ?? d.touch,
      type: d.customer_type,
      approachId: d.approach_id,
      assignedBy: d.assigned_by,
      subject: d.subject,
      body: d.body,
      status: d.status,
      skipReason: d.skip_reason,
      mailbox: "",
      person: { name: p?.name ?? `Prospect ${d.prospect_id}`, company: p?.company ?? "", email: p?.email ?? "" },
      why: {
        relationship: d.customer_type.split(":")[0],
        occasion: s?.occasion_id ?? null,
        eventDate: s?.event_date ?? "",
        basis: s?.date_basis ?? "occasion",
        source: s?.date_source ?? "occasion_calendar",
        confidence: s?.date_confidence ?? null,
        evidence: null,
      },
      prior: [],
    };
  });
  const score = obj(obj(thisRun?.score ?? rows.runs[0]?.score).types);
  const keys = [...new Set([...rows.arms.map((a) => a.customer_type), ...Object.keys(score)])].sort();
  const types: TypeFact[] = keys.map((key) => {
    const scored = arr(score[key]).map(obj);
    const mine = drafts.filter((d) => d.type === key);
    return {
      key,
      tier: tierOf(key),
      label: typeLabel(key),
      target: null,
      upcoming: [],
      emailsThisWeek: mine.length,
      sentThisWeek: mine.filter((d) => d.status === "sent").length,
      ready: 0,
      held: [],
      arms: rows.arms
        .filter((a) => a.customer_type === key)
        .map((a) => {
          const sc = scored.find((x) => x.approach_id === a.approach_id) ?? {};
          const rates = obj(sc.rates);
          const lead = rateOf(rates.lead);
          return {
            approachId: a.approach_id,
            status: a.status,
            since: a.since,
            reason: a.reason,
            sends: lead.n,
            reply: rateOf(rates.human_reply),
            lead,
            booking: rateOf(rates.booking),
            best: typeof obj(sc.chance_best).lead === "number" ? (obj(sc.chance_best).lead as number) : null,
            verdict: (sc.verdict as Verdict) ?? "learning",
            emailsThisWeek: mine.filter((d) => d.approachId === a.approach_id).length,
          };
        }),
    };
  });
  const approaches: Record<string, ApproachFact> = Object.fromEntries(
    rows.approaches.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.id.replace(/_/g, " "),
        family: a.family,
        opener: a.opener,
        structure: a.structure,
        ask: a.ask_type,
        length: a.length_band,
        baseline: a.is_baseline,
        brief: a.brief,
        createdBy: a.created_by,
        createdAt: a.created_at,
      },
    ]),
  );
  const runs = rows.runs.map((r) => runOf(r, r.week_start === weekStart ? drafts.length : 0));
  return {
    ...fill,
    synthetic: `${fill.synthetic ? "limits, occasions, research, notes and volume are synthetic; " : ""}loop runs, approaches and emails are real`,
    now: now.toISOString(),
    today,
    weekStart,
    run: runs.find((r) => r.weekStart === weekStart) ?? null,
    runs,
    types,
    approaches,
    drafts,
    flagged: [],
  };
}
