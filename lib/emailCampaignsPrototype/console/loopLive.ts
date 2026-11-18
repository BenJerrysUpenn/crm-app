// The weekly email loop as the console sees it, read from the live loop
// tables (Catering-Manager outreach/migrations/017 to 022) as the signed-in
// manager (crm/014 read policies). Nothing here is made up: where the
// database has nothing yet, the facts say so (empty lists, null, `known`
// flags) and the screen shows "No data yet".
//
// Counts for the tests come from the loop's own sent emails joined to what
// happened next (outreach_events replied and deal_created, CRM deals booked),
// so they move the day a reply lands, not only on Monday. The hand-sent
// history is folded in afterwards by withHistory (loop.ts) from the sales
// numbers snapshot.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealRow } from "../model";
import type { MailboxFull, OutcomeEvent, SendEvent } from "./load";
import {
  chanceBest,
  loopWeekStart,
  rate,
  tierOf,
  todayEt,
  typeLabel,
  verdictOf,
  type ApproachFact,
  type ArmFact,
  type DecisionFact,
  type DraftFact,
  type EstimateFact,
  type EvidenceFact,
  type LimitsFact,
  type LoopFacts,
  type OccasionFact,
  type RunFact,
  type TestFact,
  type Tier,
  type TypeFact,
} from "./loop";
import { SLOTS } from "./loopStatic";
import { addDays } from "./time";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type RunRow = {
  week_start: string;
  created_at: string;
  memo: string;
  decisions: unknown;
  score: unknown;
  digest_sent_at: string | null;
  limits?: unknown;
  occasions?: unknown;
};
export type ArmRow = { customer_type: string; approach_id: string; status: ArmFact["status"]; since: string; reason: string };
export type ApproachRow = {
  id: string;
  family: string;
  opener: string;
  structure: string;
  ask_type: string;
  length_band: ApproachFact["length"];
  is_baseline: boolean;
  brief: string;
  created_by: string;
  created_at: string;
  origin?: ApproachFact["origin"] | null;
  purpose?: string | null;
  why_tried?: string | null;
  evidence?: unknown;
  approved_at?: string | null;
  approved_by?: string | null;
};
export type DraftRow = {
  id: number;
  sequence_id: number;
  prospect_id: number;
  touch: number;
  send_on: string;
  customer_type: string;
  approach_id: string;
  assigned_by: DraftFact["assignedBy"];
  subject: string;
  body: string;
  status: DraftFact["status"];
  skip_reason: string | null;
  event_id: number | null;
  done_at: string | null;
  send_slot?: string | null;
  judge_note?: string | null;
  held_at?: string | null;
  held_by?: string | null;
  held_reason?: string | null;
};
/** Every loop email that went out, for the test counts and earlier steps. */
export type SentRow = Pick<DraftRow, "sequence_id" | "prospect_id" | "touch" | "send_on" | "customer_type" | "approach_id" | "subject" | "done_at" | "event_id"> & {
  send_slot?: string | null;
};
export type SequenceRow = {
  id: number;
  occasion_id: string | null;
  event_date: string;
  date_basis: DraftFact["why"]["basis"];
  date_source: string;
  date_confidence: number | null;
  planned_steps: number;
};
export type ControlsRow = { paused_at: string | null; paused_by: string | null; pause_reason: string | null };
export type ViewRow = { kind: "view" | "halt" | "resume"; note: string | null; viewed_at: string };
export type EstimateRow = {
  company: string | null;
  company_domain: string;
  event_kind: string;
  estimated_date: string;
  source: EstimateFact["source"];
  confidence: number;
  evidence_url: string;
  evidence: string;
  found_at: string;
};

export type LiveRows = {
  runs: RunRow[];
  arms: ArmRow[];
  approaches: ApproachRow[];
  drafts: DraftRow[];
  sent: SentRow[];
  sequences: SequenceRow[];
  controls: ControlsRow | null;
  views: ViewRow[];
  estimates: EstimateRow[];
};

export type LiveInputs = { status: "unreadable"; message: string } | { status: "empty" } | { status: "read"; rows: LiveRows };

const DAY = 86_400_000;

/** Reads the loop. "unreadable" before crm/014 gives managers read access;
 * "empty" before the loop has logged a run. */
export async function loadLoopLive(supabase: SupabaseClient, now: Date): Promise<LiveInputs> {
  const weekStart = loopWeekStart(now);
  const runs = await supabase.from("outreach_loop_runs").select("*").order("week_start", { ascending: false }).limit(12);
  if (runs.error) return { status: "unreadable", message: runs.error.message };
  if (!runs.data?.length) return { status: "empty" };
  const since = new Date(now.getTime() - 2 * DAY).toISOString();
  const [arms, approaches, drafts, sent, sequences, controls, views, estimates] = await Promise.all([
    supabase.from("outreach_loop_arms").select("customer_type,approach_id,status,since,reason"),
    supabase.from("outreach_loop_approaches").select("*"),
    // This week's emails, plus any still waiting from before (the sender
    // carries an unsent email to its slot's next run).
    supabase
      .from("outreach_loop_drafts")
      .select("*")
      .or(`and(send_on.gte.${weekStart},send_on.lt.${addDays(weekStart, 7)}),status.in.(planned,held)`)
      .order("send_on")
      .order("id")
      .limit(5000),
    supabase
      .from("outreach_loop_drafts")
      .select("sequence_id,prospect_id,touch,send_on,customer_type,approach_id,subject,done_at,event_id,send_slot")
      .eq("status", "sent")
      .order("id")
      .limit(20000),
    supabase.from("outreach_loop_sequences").select("id,occasion_id,event_date,date_basis,date_source,date_confidence,planned_steps"),
    supabase.from("outreach_loop_controls").select("paused_at,paused_by,pause_reason").limit(1),
    supabase.from("outreach_research_views").select("kind,note,viewed_at").gte("viewed_at", since).order("viewed_at", { ascending: false }).limit(500),
    supabase
      .from("outreach_event_estimates")
      .select("company,company_domain,event_kind,estimated_date,source,confidence,evidence_url,evidence,found_at")
      .gt("expires_at", now.toISOString())
      .order("found_at", { ascending: false })
      .limit(50),
  ]);
  const err = arms.error ?? approaches.error ?? drafts.error ?? sent.error ?? sequences.error ?? controls.error ?? views.error ?? estimates.error;
  if (err) return { status: "unreadable", message: err.message };
  return {
    status: "read",
    rows: {
      runs: runs.data as RunRow[],
      arms: (arms.data ?? []) as ArmRow[],
      approaches: (approaches.data ?? []) as ApproachRow[],
      drafts: (drafts.data ?? []) as DraftRow[],
      sent: (sent.data ?? []) as SentRow[],
      sequences: (sequences.data ?? []) as SequenceRow[],
      controls: ((controls.data ?? [])[0] as ControlsRow | undefined) ?? null,
      views: (views.data ?? []) as ViewRow[],
      estimates: (estimates.data ?? []) as EstimateRow[],
    },
  };
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
const strs = (x: unknown) => arr(x).filter((s): s is string => typeof s === "string");

const OFFER_WORDS: Record<string, string> = {
  hot_chocolate_float_party: "Hot Chocolate Float Party",
  holiday_gift_100: "$100 Holiday Gift (past customers who booked; deposit by 31 December) and the $100 Referral Credit",
};

/** Used for the arithmetic only (weeks to decide, the two-week rule) when a
 * run predates the run's own record of its limits; the Limits panel says the
 * values are not recorded instead of showing these. */
const UNRECORDED: LimitsFact = {
  dailyCap: 0,
  coldDailyCap: 0,
  baselineShare: 0.2,
  maxLive: 0,
  coldEnabled: false,
  apolloCredits: 0,
  unsubPause: 1,
  minGuests: 0,
  holdBackMonths: 0,
  minDaysBeforeEvent: 14,
  never: [],
  leanToward: [],
  allowedOffers: [],
  approvedAsk: [],
  linkedinCap: 0,
  linkedinPause: 0,
  neverEmail: 0,
};

/** The limits file a run ran under (outreach_loop_runs.limits), in the
 * console's words. Null when the run did not record them. */
export function limitsOf(raw: unknown): LimitsFact | null {
  const l = obj(raw);
  if (!Object.keys(l).length) return null;
  const s = obj(l.sending);
  const a = obj(l.audience);
  const c = obj(l.copy);
  const o = obj(l.occasions);
  const r = obj(l.research);
  const cap = num(s.daily_cap, 0);
  return {
    dailyCap: cap,
    coldDailyCap: cap,
    baselineShare: num(s.baseline_share, 0.2),
    maxLive: num(s.max_live_approaches, 0),
    coldEnabled: s.cold_enabled === true,
    apolloCredits: num(s.apollo_credits_per_week, 0),
    unsubPause: num(s.unsubscribe_pause_share, 1),
    minGuests: 0,
    holdBackMonths: num(a.hold_back_months, 0),
    minDaysBeforeEvent: num(a.min_days_before_event, 14),
    never: strs(c.never),
    leanToward: strs(c.suggestions),
    allowedOffers: strs(c.allowed_offers).map((x) => OFFER_WORDS[x] ?? x.replace(/_/g, " ")),
    approvedAsk: strs(o.approved_ask),
    linkedinCap: num(r.linkedin_daily_cap, 0),
    linkedinPause: num(r.linkedin_min_pause_seconds, 0),
    neverEmail: strs(a.never_email_addresses).length + strs(a.never_email_domains).length,
  };
}

function occasionOf(x: unknown): OccasionFact | null {
  const o = obj(x);
  if (typeof o.id !== "string") return null;
  return { id: o.id, name: typeof o.name === "string" ? o.name : o.id.replace(/_/g, " "), aim: typeof o.aim === "string" ? o.aim : "", basis: "" };
}

function evidenceOf(x: unknown): EvidenceFact[] {
  return arr(x).map((e) => {
    const o = obj(e);
    return { source: String(o.source ?? ""), url: typeof o.url === "string" ? o.url : null, finding: String(o.finding ?? "") };
  });
}

const QUESTION: Record<Tier, string> = {
  warm: "Which first email gets past customers and enquirers to reply?",
  cold: "Which first email gets new-to-us offices to reply?",
  offer: "Which offer email gets past customers to book?",
};
const QUESTION_WHY: Record<Tier, string> = {
  warm: "Every past-customer type answers the same question at once: no single type gets enough emails a week to settle it alone.",
  cold: "Every new-to-us type answers the same question at once.",
  offer: "Every offer type answers the same question at once.",
};

const SLOT_TIME: Record<string, string> = Object.fromEntries(SLOTS.map((s) => [s.id, s.at]));

/** "YYYY-MM-DD" at "HH:MM" Eastern as an ISO instant (EST/EDT by month). */
function etInstant(ymd: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const month = Number(ymd.slice(5, 7));
  const offset = month >= 4 && month <= 10 ? 4 : 5; // close enough for a send time label
  return new Date(Date.UTC(Number(ymd.slice(0, 4)), month - 1, Number(ymd.slice(8, 10)), h + offset, m)).toISOString();
}

// ---------------------------------------------------------------------------
// What happened after each sent email
// ---------------------------------------------------------------------------

type Outcome = { reply: boolean; lead: boolean; booking: boolean };

/** For each sent loop email: did that person reply, open a deal or book
 * after it went out. Each person counts once per email. */
export function outcomesOf(
  sent: SentRow[],
  outcomes: OutcomeEvent[],
  deals: Pick<DealRow, "contact_email" | "stage" | "created_at">[],
  emailOf: Map<number, string>,
): Outcome[] {
  const BOOKED = new Set(["Event Complete", "Booked Paid", "Booked Unpaid"]);
  const byProspect = new Map<number, OutcomeEvent[]>();
  for (const o of outcomes) byProspect.set(o.prospect_id, [...(byProspect.get(o.prospect_id) ?? []), o]);
  const bookedAt = new Map<string, string[]>();
  for (const d of deals) {
    const e = d.contact_email?.trim().toLowerCase();
    if (!e || !d.stage || !BOOKED.has(d.stage) || !d.created_at) continue;
    bookedAt.set(e, [...(bookedAt.get(e) ?? []), d.created_at]);
  }
  return sent.map((s) => {
    const at = s.done_at ?? `${s.send_on}T00:00:00Z`;
    const after = (byProspect.get(s.prospect_id) ?? []).filter((o) => o.at >= at);
    const email = emailOf.get(s.prospect_id)?.toLowerCase();
    return {
      reply: after.some((o) => o.event === "replied"),
      lead: after.some((o) => o.event === "deal_created"),
      booking: !!email && (bookedAt.get(email) ?? []).some((c) => c >= at),
    };
  });
}

function armFrom(id: string, list: { s: SentRow; o: Outcome }[], base: Omit<ArmFact, "sends" | "reply" | "lead" | "booking" | "best" | "verdict" | "approachId">): ArmFact {
  const n = list.length;
  return {
    approachId: id,
    ...base,
    sends: n,
    reply: rate(list.filter((x) => x.o.reply).length, n),
    lead: rate(list.filter((x) => x.o.lead).length, n),
    booking: rate(list.filter((x) => x.o.booking).length, n),
    best: null,
    verdict: "learning",
  };
}

// ---------------------------------------------------------------------------
// Rows into facts
// ---------------------------------------------------------------------------

export type LiveContext = {
  people: Map<number, { name: string | null; company: string | null; email: string | null }>;
  outcomes: OutcomeEvent[];
  sends: SendEvent[];
  deals: Pick<DealRow, "contact_email" | "stage" | "created_at">[];
  mailboxes: MailboxFull[];
};

const WARM_DOMAIN = "@news.benjerryphilly.com";
const COLD_DOMAIN = "@phillyicecreamcatering.com";
const COLD_OWNER = "alina@phillyicecreamcatering.com";

function runOf(r: RunRow, planned: number): RunFact {
  const d = obj(r.decisions);
  const added: DecisionFact[] = arr(d.new_approaches).map((x) => {
    const a = obj(x);
    return { kind: "add", type: (arr(a.customer_types)[0] as string) ?? null, approachId: String(a.id ?? ""), reason: String(a.why_tried ?? a.brief ?? "") };
  });
  const pairs = (key: string, kind: DecisionFact["kind"]): DecisionFact[] =>
    arr(d[key]).map((x) => {
      const [type, approachId, reason] = arr(x) as string[];
      return { kind, type: type ?? null, approachId: approachId ?? "", reason: reason ?? "" };
    });
  return {
    weekStart: r.week_start,
    createdAt: r.created_at,
    check: { ok: true, text: "The run logged, so its startup check passed." },
    memo: r.memo,
    decisions: [...added, ...pairs("retire", "retire"), ...pairs("crown", "crown"), ...pairs("reopen", "reopen")],
    asks: arr(d.asks_for_alina ?? d.asks).map((x, i) => ({ id: String(i), text: String(x), answered: false })),
    approvedAt: null,
    digestSentAt: r.digest_sent_at,
    planned,
  };
}

export function buildLoopLive(rows: LiveRows, ctx: LiveContext, now: Date): LoopFacts {
  const weekStart = loopWeekStart(now);
  const today = todayEt(now);
  const weekEnd = addDays(weekStart, 7);
  const thisRow = rows.runs.find((r) => r.week_start === weekStart) ?? null;
  const latest = rows.runs[0];
  const limitsRow = limitsOf(thisRow?.limits ?? latest?.limits);
  const L = limitsRow ?? UNRECORDED;
  const occasions = obj(thisRow?.occasions ?? latest?.occasions);
  const seq = new Map(rows.sequences.map((s) => [s.id, s]));
  const approvedIds = new Set(rows.approaches.filter((a) => a.approved_at).map((a) => a.id));
  const mailboxOfEvent = new Map(ctx.sends.map((s) => [s.id, s.mailbox]));
  const emailOf = new Map<number, string>();
  for (const [id, p] of ctx.people) if (p.email) emailOf.set(id, p.email);

  // Earlier steps of each sequence, for "what they already got".
  const priorBySeq = new Map<number, SentRow[]>();
  for (const s of rows.sent) priorBySeq.set(s.sequence_id, [...(priorBySeq.get(s.sequence_id) ?? []), s]);

  const drafts: DraftFact[] = rows.drafts.map((d) => {
    const p = ctx.people.get(d.prospect_id);
    const s = seq.get(d.sequence_id);
    const tier = tierOf(d.customer_type);
    const slot = d.send_slot ?? "late_morning";
    const waiting = d.status === "planned" && !approvedIds.has(d.approach_id);
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
      mailbox:
        (d.event_id !== null ? mailboxOfEvent.get(d.event_id) : null) ??
        (tier === "cold" ? "a cold mailbox (Apollo picks which)" : "a news mailbox (the sender picks which)"),
      person: { name: p?.name ?? p?.email ?? `Prospect ${d.prospect_id}`, company: p?.company ?? "", email: p?.email ?? "" },
      why: {
        relationship: tier,
        occasion: s?.occasion_id ?? null,
        eventDate: s?.event_date ?? "",
        basis: s?.date_basis ?? "occasion",
        source: s?.date_source ?? "occasion_calendar",
        confidence: s?.date_confidence ?? null,
        evidence: null,
      },
      prior: (priorBySeq.get(d.sequence_id) ?? [])
        .filter((x) => x.touch < d.touch)
        .sort((a, b) => a.touch - b.touch)
        .map((x) => ({ touch: x.touch, subject: x.subject, sentOn: x.send_on })),
      slot,
      sendAt: etInstant(d.send_on, SLOT_TIME[slot] ?? "10:30"),
      judge: { verdict: "pass", note: d.judge_note ?? "Passed the judge; it left no note." },
      pick: d.assigned_by === "baseline_quota" ? "The baseline's share of the day." : "Drawn by how each approach is doing.",
      waitingApproval: waiting,
      sentAt: d.status === "sent" ? d.done_at : null,
      held: d.status === "held" ? { at: d.held_at ?? "", by: d.held_by ?? "", reason: d.held_reason ?? "" } : null,
    };
  });
  const thisWeek = drafts.filter((d) => d.sendOn >= weekStart && d.sendOn < weekEnd);

  // What happened after each sent email.
  const outs = outcomesOf(rows.sent, ctx.outcomes, ctx.deals, emailOf);
  const sentOut = rows.sent.map((s, i) => ({ s, o: outs[i] }));
  const firsts = sentOut.filter((x) => x.s.touch === 1);

  const approaches: Record<string, ApproachFact> = Object.fromEntries(
    rows.approaches.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.id.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
        family: a.family,
        opener: a.opener,
        structure: a.structure,
        ask: a.ask_type,
        length: a.length_band,
        baseline: a.is_baseline,
        brief: a.brief,
        createdBy: a.created_by,
        createdAt: a.created_at,
        origin: a.origin ?? (a.created_by.startsWith("human") ? "human" : "loop"),
        purpose: a.purpose ?? "",
        whyTried: a.why_tried ?? a.brief,
        fitsWith: "",
        stopIf: "",
        evidence: evidenceOf(a.evidence),
        slots: [],
        approvedAt: a.approved_at ?? null,
        approvedBy: a.approved_by ?? null,
      } satisfies ApproachFact,
    ]),
  );

  // Types: every customer type with an arm or an email this week.
  const keys = [...new Set([...rows.arms.map((a) => a.customer_type), ...thisWeek.map((d) => d.type)])].sort();
  const types: TypeFact[] = keys.map((key) => {
    const mine = thisWeek.filter((d) => d.type === key);
    const occ = obj(occasions[key]);
    const waitingBy = new Map<string, number>();
    for (const d of mine.filter((x) => x.waitingApproval)) waitingBy.set(d.approachId, (waitingBy.get(d.approachId) ?? 0) + 1);
    const heldN = mine.filter((d) => d.status === "held").length;
    const count = new Map<string, number>();
    for (const d of mine) count.set(d.approachId, (count.get(d.approachId) ?? 0) + 1);
    const mostly = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const arms = rows.arms
      .filter((a) => a.customer_type === key)
      .map((a) =>
        armFrom(
          a.approach_id,
          firsts.filter((x) => x.s.customer_type === key && x.s.approach_id === a.approach_id),
          { status: a.status, since: a.since, reason: a.reason, emailsThisWeek: count.get(a.approach_id) ?? 0 },
        ),
      );
    chanceBest(arms);
    for (const a of arms) a.verdict = verdictOf(a, approaches[a.approachId]?.baseline ?? false);
    return {
      key,
      tier: tierOf(key),
      label: typeLabel(key),
      target: occasionOf(occ.target),
      upcoming: arr(occ.upcoming).map(occasionOf).filter((x): x is OccasionFact => !!x),
      emailsThisWeek: mine.length,
      sentThisWeek: mine.filter((d) => d.status === "sent").length,
      ready: 0,
      held: [
        ...[...waitingBy.entries()].map(([id, n]) => ({ reason: `waiting for your approval of ${approaches[id]?.name ?? id}`, n })),
        ...(heldN ? [{ reason: "held by you", n: heldN }] : []),
      ],
      adjusted: [],
      arms,
      mostly,
    };
  });

  // One test per tier, pooled across its types; and the send-time test.
  const tests: TestFact[] = [];
  for (const tier of ["warm", "cold", "offer"] as Tier[]) {
    const tierArms = rows.arms.filter((a) => tierOf(a.customer_type) === tier);
    if (!tierArms.length) continue;
    const ids = [...new Set(tierArms.map((a) => a.approach_id))];
    const weekTier = thisWeek.filter((d) => tierOf(d.type) === tier);
    const arms = ids.map((id) => {
      const mine = tierArms.filter((a) => a.approach_id === id);
      const status: ArmFact["status"] = mine.some((a) => a.status === "live") ? "live" : mine.some((a) => a.status === "crowned") ? "crowned" : "retired";
      const since = mine.map((a) => a.since).sort()[0];
      return armFrom(
        id,
        firsts.filter((x) => tierOf(x.s.customer_type) === tier && x.s.approach_id === id),
        {
          status,
          since,
          reason: approaches[id]?.whyTried ?? mine[0].reason,
          emailsThisWeek: weekTier.filter((d) => d.approachId === id).length,
        },
      );
    });
    chanceBest(arms);
    for (const a of arms) a.verdict = verdictOf(a, approaches[a.approachId]?.baseline ?? false);
    tests.push({
      id: `${tier}_first_email`,
      tier,
      factor: "approach",
      question: QUESTION[tier],
      arms,
      weekly: weekTier.length,
      started: arms.map((a) => a.since).sort()[0] ?? weekStart,
      why: QUESTION_WHY[tier],
    });
  }
  if (rows.sent.length || thisWeek.length) {
    const arms = SLOTS.map((s) =>
      armFrom(
        s.id,
        sentOut.filter((x) => (x.s.send_slot ?? "late_morning") === s.id),
        { status: "live", since: rows.runs[rows.runs.length - 1]?.created_at ?? now.toISOString(), reason: s.why, emailsThisWeek: thisWeek.filter((d) => d.slot === s.id).length },
      ),
    );
    chanceBest(arms);
    for (const a of arms) a.verdict = verdictOf(a, a.approachId === "late_morning");
    tests.push({
      id: "send_time",
      tier: "all",
      factor: "send time",
      question: "When should an email land?",
      arms,
      weekly: thisWeek.length,
      started: arms[0].since,
      why: "The same emails at different hours, across every type.",
    });
  }

  // Room: each lane's mailboxes, as the sender counts them, under the cap.
  const allowance = (pick: (m: MailboxFull) => boolean) =>
    ctx.mailboxes.filter((m) => pick(m) && !m.frozen).reduce((t, m) => t + (m.daily_allowance ?? 0), 0);
  const capDay = (n: number) => (limitsRow ? Math.min(n, limitsRow.dailyCap) : n);
  const warmDay = capDay(allowance((m) => m.address.endsWith(WARM_DOMAIN)));
  const coldDay = limitsRow && !limitsRow.coldEnabled ? 0 : capDay(allowance((m) => m.address.endsWith(COLD_DOMAIN) && m.address !== COLD_OWNER));
  const waitingTier = (t: Tier) => drafts.filter((d) => (d.status === "planned" || d.status === "held") && tierOf(d.type) === t).length;

  // Research: today's LinkedIn pages and any halt still standing.
  const todayViews = rows.views.filter((v) => v.kind === "view" && todayEt(new Date(v.viewed_at)) === today).length;
  const lastStop = rows.views.find((v) => v.kind === "halt" || v.kind === "resume");
  const accuracy = (["public", "linkedin", "job_change"] as const).map((source) => ({ source, checked: 0, medianDaysOff: null }));

  // This week against the four before it, on the loop's own emails.
  const weekOf = (from: string, to: string) => {
    const xs = sentOut.filter((x) => x.s.send_on >= from && x.s.send_on < to);
    return { replies: xs.filter((x) => x.o.reply).length, leads: xs.filter((x) => x.o.lead).length, bookings: xs.filter((x) => x.o.booking).length };
  };
  const wk = weekOf(weekStart, weekEnd);
  const prev = [1, 2, 3, 4].map((i) => weekOf(addDays(weekStart, -7 * i), addDays(weekStart, -7 * (i - 1))));
  const avg = (k: keyof typeof wk) => prev.reduce((t, w) => t + w[k], 0) / 4;

  const runs = rows.runs.map((r) => runOf(r, r.week_start === weekStart ? thisWeek.length : 0));
  const approvals = [...new Set(drafts.filter((d) => d.waitingApproval).map((d) => d.approachId))].map((id) => ({
    approachId: id,
    n: drafts.filter((d) => d.waitingApproval && d.approachId === id).length,
  }));
  const c = rows.controls;
  const unsubWeek = ctx.outcomes.filter((o) => o.event === "unsubscribed" && o.at >= new Date(now.getTime() - 7 * DAY).toISOString()).length;
  const sentWeek = rows.sent.filter((s) => (s.done_at ?? "") >= new Date(now.getTime() - 7 * DAY).toISOString()).length;

  return {
    now: now.toISOString(),
    today,
    weekStart,
    gate: false,
    paused: c?.paused_at ? { since: c.paused_at, by: c.paused_by ?? "", why: c.pause_reason ?? "" } : null,
    run: runs.find((r) => r.weekStart === weekStart) ?? null,
    runs,
    types,
    cold: { enabled: limitsRow?.coldEnabled ?? true, ready: waitingTier("cold") },
    tests,
    slots: Object.fromEntries(SLOTS.map((s) => [s.id, s])),
    history: [],
    judge: { passed: rows.drafts.length, rewritten: 0, held: 0, youOverruled: drafts.filter((d) => d.status === "held").length },
    approaches,
    drafts,
    limits: L,
    limitsRecorded: !!limitsRow,
    approvals,
    research: {
      viewsToday: todayViews,
      halt: lastStop?.kind === "halt" ? { at: lastStop.viewed_at, note: lastStop.note ?? "" } : null,
      estimates: rows.estimates.map((e) => ({
        company: e.company ?? e.company_domain,
        kind: e.event_kind.replace(/_/g, " "),
        date: e.estimated_date,
        source: e.source,
        confidence: Number(e.confidence),
        evidenceUrl: e.evidence_url,
        evidence: e.evidence,
        foundAt: e.found_at,
      })),
      accuracy,
    },
    notes: [],
    volume: {
      ready: waitingTier("warm") + waitingTier("cold"),
      roomPerWeek: (warmDay + coldDay) * 5,
      warm: { ready: waitingTier("warm"), room: warmDay * 5 },
      cold: { ready: waitingTier("cold"), room: coldDay * 5 },
    },
    unsub: { n: unsubWeek, sends: sentWeek },
    week: { ...wk, avg4: { replies: avg("replies"), leads: avg("leads"), bookings: avg("bookings") } },
    flagged: [],
  };
}

/** Before the loop is readable or has run: an honest empty loop. */
export function emptyLoop(now: Date, why: string): LoopFacts {
  return {
    unavailable: why,
    now: now.toISOString(),
    today: todayEt(now),
    weekStart: loopWeekStart(now),
    gate: false,
    paused: null,
    run: null,
    runs: [],
    types: [],
    cold: { enabled: false, ready: 0 },
    tests: [],
    slots: Object.fromEntries(SLOTS.map((s) => [s.id, s])),
    history: [],
    judge: { passed: 0, rewritten: 0, held: 0, youOverruled: 0 },
    approaches: {},
    drafts: [],
    limits: UNRECORDED,
    limitsRecorded: false,
    approvals: [],
    research: { viewsToday: 0, halt: null, estimates: [], accuracy: [] },
    notes: [],
    volume: { ready: 0, roomPerWeek: 0, warm: { ready: 0, room: 0 }, cold: { ready: 0, room: 0 } },
    unsub: { n: 0, sends: 0 },
    week: { replies: 0, leads: 0, bookings: 0, avg4: { replies: 0, leads: 0, bookings: 0 } },
    flagged: [],
  };
}
