// PROTOTYPE (bj-finance #811 rounds 3 and 4), throwaway. A synthetic week of
// the weekly email loop. Round 4 (Alina's review, 2026-11-15):
//   - the emails people sent by hand are the starting data: the holiday
//     letter and Cold Pilot A are the baselines, the $100 Holiday Gift is an
//     approach in the loop, the wedding follow-up is retired. Their counts are
//     added at runtime from the sales numbers (loop.ts withHistory), so no
//     real number is written into this public repo;
//   - cold sends again, at its own daily cap;
//   - one question at a time, pooled across every type it fits, because no
//     single type gets enough emails a week to settle anything on its own;
//   - send time is its own test (late morning, before lunch, 3pm slump);
//   - a judge reads every email whole before it is planned;
//   - offices are aimed at holiday party season (the term Challenger, Gray &
//     Christmas uses; "year-end thank-you" is not a category anyone tracks).
//
// Every person and company here is invented. Every number is marked
// synthetic on screen. Nothing is read from or written to the database.

import {
  chanceBest,
  loopWeekStart,
  rate,
  todayEt,
  typeLabel,
  verdictOf,
  type ApproachFact,
  type ArmFact,
  type DraftFact,
  type EvidenceFact,
  type LoopFacts,
  type OccasionFact,
  type RunFact,
  type SlotFact,
  type TestFact,
  type TypeFact,
} from "./loop";
import { E, SLOTS } from "./loopStatic";
import { addDays } from "./time";

const TAG = "synthetic loop week (nothing has run live yet)";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 'YYYY-MM-DD' at hh:mm New York time (EST in winter), as ISO. */
const etAt = (ymd: string, h: number, m = 0) => new Date(`${ymd}T${String(h + 5).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`).toISOString();

// ---------------------------------------------------------------------------
// Evidence (each URL opened by the research pass on 2026-11-15)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Approaches
// ---------------------------------------------------------------------------

type ApproachSeed = Omit<ApproachFact, "slots"> & { slots?: string[] };

const APPROACHES: ApproachSeed[] = [
  {
    id: "holiday_letter",
    name: "Holiday letter",
    family: "offer",
    opener: "Who we are and the winter menu",
    structure: "who we are, the winter menu, the occasions, a same-day quote",
    ask: "tell us about an event",
    length: "medium",
    baseline: true,
    origin: "human",
    brief: "The warm email we sent by hand from 27 October: the owner introduces the shop, the cold-weather menu and the events we do.",
    purpose: "Remind people who already know us that we cater, and that winter has its own menu.",
    whyTried: "It is what we sent before the loop. Its sends are the starting data, so a new email is measured against months of real replies.",
    fitsWith: "Nothing to fit: it is sent unchanged apart from name and company.",
    stopIf: "Never retired. It is the yardstick.",
    evidence: [E.ours("Every warm email since August; the counts show under Numbers.")],
    createdBy: "Alina, by hand",
    createdAt: "2026-10-27T14:00:00Z",
  },
  {
    id: "holiday_gift",
    name: "$100 Holiday Gift",
    family: "offer",
    opener: "A thank-you gift for their last event",
    structure: "thanks for last time, $100 off with a 31 December deposit, the referral credit",
    ask: "pay a deposit by 31 December",
    length: "short",
    baseline: false,
    origin: "human",
    brief: "The Offer lane's email from 9 November, folded into the loop. Past customers who booked only.",
    purpose: "Give people who already booked a reason to book the next one now.",
    whyTried: "We tried it by hand in November. In the loop it competes in the same test as everything else instead of running on its own.",
    fitsWith: "The offer, its deadline and the referral credit have to agree; a question opener or a picture can sit in front of it.",
    stopIf: "Replies no better than the letter's, or deposits that would have come anyway (the discount costs $100 a booking).",
    evidence: [E.ours("Its November sends; the counts show under Numbers.")],
    createdBy: "Alina, by hand",
    createdAt: "2026-11-09T14:00:00Z",
  },
  {
    id: "cold_pilot_a",
    name: "Cold Pilot A",
    family: "offer",
    opener: "Ice cream catering for their office",
    structure: "who we are, what we bring, a quote",
    ask: "a date and a headcount",
    length: "short",
    baseline: true,
    origin: "human",
    brief: "The Apollo cold sequence we ran by hand from August.",
    purpose: "Introduce us to offices that have never heard of the shop.",
    whyTried: "It is what we sent before the loop, so it is the cold baseline.",
    fitsWith: "Sent unchanged apart from name and company.",
    stopIf: "Never retired. It is the cold yardstick.",
    evidence: [E.ours("Every cold email since August; the counts show under Numbers.")],
    createdBy: "Alina, by hand",
    createdAt: "2026-08-12T14:00:00Z",
  },
  {
    id: "question_opener",
    name: "Question first",
    family: "question",
    opener: "One plain question about their plans",
    structure: "one question, one line on the party, the ask",
    ask: "whether they are interested",
    length: "short",
    baseline: false,
    origin: "research",
    brief: "Open with one question they can answer in a word, then one line on the Hot Chocolate Float Party. Ask if they are interested, not for a meeting.",
    purpose: "Make replying take less effort than ignoring.",
    whyTried: "Two large studies found an interest ask beats a set time on first contact. A counter-study warns that more than one question costs replies.",
    fitsWith: "Exactly one question. The question has to lead into the party, and the ask has to answer the question.",
    stopIf: "Replies no better than the letter's, or replies that rarely become quotes.",
    evidence: [E.gongLabs, E.gongBlog, E.replyIo],
    createdBy: "The loop, from your research list",
    createdAt: "2026-10-26T14:00:00Z",
  },
  {
    id: "hcf_picture",
    name: "Paint the party",
    family: "product",
    opener: "A picture of the Hot Chocolate Float Party",
    structure: "the picture, why people book it, the ask",
    ask: "a date and a headcount",
    length: "medium",
    baseline: false,
    origin: "research",
    brief: "Lead with what the guests see and taste.",
    purpose: "Make the reader want it before they see what it involves.",
    whyTried: "Copy that uses several senses raises expected taste. Untested on busy office readers.",
    fitsWith: "The picture has to be the same event the ask books, at their office.",
    stopIf: "Flat against the letter, which would mean busy readers skim past it.",
    evidence: [E.elder],
    createdBy: "The loop, from your research list",
    createdAt: "2026-10-26T14:00:00Z",
  },
  {
    id: "last_event_callback",
    name: "Your last event",
    family: "relationship",
    opener: "Their last event with us, from the booking",
    structure: "callback, what is new, the ask",
    ask: "a date to hold",
    length: "short",
    baseline: false,
    origin: "research",
    brief: "Name the month we last scooped for them and offer to hold a date.",
    purpose: "Show we remember them and make rebooking the obvious next step.",
    whyTried: "Personal detail lifts leads when people know where it came from.",
    fitsWith: "The month and event must match the booking exactly.",
    stopIf: "More unsubscribes or 'how do you know that' replies, or no better than the letter.",
    evidence: [E.sahni, E.aguirre],
    createdBy: "The loop, from your research list",
    createdAt: "2026-11-02T14:00:00Z",
  },
  {
    id: "budget_close",
    name: "Year-end budget",
    family: "timing",
    opener: "Budget left before it lapses",
    structure: "budget line, the party, the ask",
    ask: "a date and a headcount",
    length: "short",
    baseline: false,
    origin: "research",
    brief: "Offices with a calendar year: budget left in December can pay for the team's party.",
    purpose: "Turn leftover budget into a reason to book now.",
    whyTried: "Spending jumps at the end of a budget year. The study is of government buyers, not offices.",
    fitsWith: "Only for organisations whose year ends in December.",
    stopIf: "Replies saying 'no budget' or 'our year ends in June'.",
    evidence: [E.liebman],
    createdBy: "The loop, from your research list",
    createdAt: "2026-11-02T14:00:00Z",
  },
  {
    id: "pick_me_up",
    name: "3pm pick-me-up",
    family: "timing",
    opener: "The afternoon slump",
    structure: "one line on the slump, the party, the ask",
    ask: "whether they are interested",
    length: "short",
    baseline: false,
    origin: "loop",
    slots: ["slump"],
    brief: "Very short, lands at 3pm, and says so: the holiday party as the cure for the afternoon slump. The loop's own idea, outside your research list.",
    purpose: "Catch them while they want a treat, so the party sounds like relief, not another task.",
    whyTried: "Most office workers reach for a treat mid-afternoon, and hungry people choose more treats for later. Vendor send-time data leans the other way, so the time test checks the hour on its own.",
    fitsWith: "Only sent in the 3pm slot; the opening line has to be true when it lands.",
    stopIf: "Fewer replies than the same week's late-morning emails.",
    evidence: [E.ezcater, E.monk, E.read, E.belkins],
    createdBy: "The loop's own idea",
    createdAt: "2026-11-16T11:00:00Z",
  },
];


// ---------------------------------------------------------------------------
// Occasions and types
// ---------------------------------------------------------------------------

const HOL: OccasionFact = { id: "holiday_party_season", name: "Holiday party season", aim: "12-12", basis: "the middle of 1 to 23 December. 64% of companies planned a party in 2024, most during work hours (Challenger, Gray & Christmas)" };
const EAD: OccasionFact = { id: "employee_appreciation_day", name: "Employee Appreciation Day", aim: "03-05", basis: "first Friday of March" };
const VAL: OccasionFact = { id: "valentines_day", name: "Valentine's Day", aim: "02-14", basis: "fixed date" };
const APD: OccasionFact = { id: "admin_professionals_day", name: "Administrative Professionals Day", aim: "04-21", basis: "Wednesday of the last full week of April" };
const TAW: OccasionFact = { id: "teacher_appreciation_week", name: "Teacher Appreciation Week", aim: "05-05", basis: "first full week of May" };
const VOL: OccasionFact = { id: "volunteer_week", name: "National Volunteer Week", aim: "04-21", basis: "third full week of April" };
const NUR: OccasionFact = { id: "nurses_week", name: "Nurses Week", aim: "05-09", basis: "6 to 12 May" };
const RES: OccasionFact = { id: "resident_events", name: "Resident holiday events", aim: "12-10", basis: "buildings hold them early in December" };

type TypeSeed = { key: string; target: OccasionFact; upcoming: OccasionFact[]; week: number; ready: number; held: [string, number][]; small: number };

const TYPES: TypeSeed[] = [
  { key: "warm:office_manager", target: HOL, upcoming: [VAL, EAD, APD], week: 26, ready: 388, held: [["Event under 14 days away (Fair Workweek)", 6], ["Held back 6 months after a closed-lost deal", 11]], small: 9 },
  { key: "warm:exec_admin", target: HOL, upcoming: [EAD, APD], week: 16, ready: 241, held: [["Held back 6 months after a closed-lost deal", 4]], small: 2 },
  { key: "warm:corporate_events", target: HOL, upcoming: [VAL, EAD], week: 16, ready: 196, held: [["Event under 14 days away (Fair Workweek)", 3]], small: 0 },
  { key: "warm:hr_people_ops", target: HOL, upcoming: [EAD, APD], week: 14, ready: 162, held: [], small: 1 },
  { key: "warm:education", target: HOL, upcoming: [TAW], week: 18, ready: 187, held: [], small: 5 },
  { key: "warm:nonprofit_events", target: HOL, upcoming: [VOL], week: 14, ready: 121, held: [["A personal note from you instead (refund)", 1]], small: 3 },
  { key: "warm:healthcare_practice", target: HOL, upcoming: [NUR], week: 10, ready: 74, held: [], small: 4 },
  { key: "warm:property_mgmt", target: RES, upcoming: [VAL], week: 6, ready: 36, held: [], small: 0 },
  { key: "cold:hr_people_ops", target: HOL, upcoming: [EAD, APD], week: 84, ready: 830, held: [], small: 0 },
  { key: "cold:exec_admin", target: HOL, upcoming: [EAD, APD], week: 72, ready: 690, held: [], small: 0 },
  { key: "cold:property_mgmt", target: RES, upcoming: [VAL], week: 66, ready: 650, held: [], small: 0 },
  { key: "cold:office_manager", target: HOL, upcoming: [VAL, EAD, APD], week: 54, ready: 470, held: [["Event under 14 days away (Fair Workweek)", 2]], small: 0 },
  { key: "cold:law_admin", target: HOL, upcoming: [APD], week: 24, ready: 160, held: [], small: 0 },
];

// Pooled loop sends so far (the hand-sent history is added at runtime).
type ArmSeed = [id: string, sends: number, replies: number, leads: number, bookings: number, status: ArmFact["status"], since: number, reason: string];
const TEST_SEEDS: { id: string; tier: TestFact["tier"]; factor: TestFact["factor"]; question: string; weekly: number; started: number; why: string; arms: ArmSeed[] }[] = [
  {
    id: "warm_first_email",
    tier: "warm",
    factor: "approach",
    question: "Which first email gets past customers and enquirers to reply?",
    weekly: 120,
    started: -21,
    why: "Every warm type answers the same question at once: no single type gets enough emails a week to settle it alone.",
    arms: [
      ["holiday_letter", 64, 2, 1, 0, "live", -21, "The baseline: 20% of the week, every week."],
      ["question_opener", 176, 9, 4, 1, "live", -21, "Started in week 1 from your research list."],
      ["holiday_gift", 40, 2, 1, 0, "live", -7, "Folded in from the Offer lane in week 3."],
      ["pick_me_up", 0, 0, 0, 0, "live", 0, "Started this week: the loop's own idea."],
      ["hcf_picture", 150, 5, 2, 0, "retired", 0, "Set aside this week so the test settles in about half the time: fewer approaches, more emails each."],
      ["last_event_callback", 151, 1, 0, 0, "retired", -7, "1 reply in 151 emails."],
      ["budget_close", 58, 1, 0, 0, "retired", -7, "Schools replied that their year ends in June; offices no better than the letter."],
    ],
  },
  {
    id: "cold_first_email",
    tier: "cold",
    factor: "approach",
    question: "Which first email gets new-to-us offices to reply?",
    weekly: 300,
    started: 0,
    why: "Cold sends again this week. At cold's reply rate it borrows the leader from past customers and tests only that against the old cold email.",
    arms: [
      ["cold_pilot_a", 0, 0, 0, 0, "live", 0, "The cold baseline."],
      ["question_opener", 0, 0, 0, 0, "live", 0, "Borrowed from the past-customer test, where it leads."],
    ],
  },
  {
    id: "send_time",
    tier: "all",
    factor: "send time",
    question: "When should an email land?",
    weekly: 420,
    started: -7,
    why: "The same emails at different hours, across every type. Everything so far went out around 10am, so this is new ground.",
    arms: [
      ["late_morning", 104, 4, 2, 0, "live", -7, "The baseline: where nearly everything has gone so far."],
      ["before_lunch", 98, 5, 2, 0, "live", -7, "Started last week."],
      ["slump", 96, 3, 1, 0, "live", -7, "Started last week."],
    ],
  },
];

// ---------------------------------------------------------------------------
// People and copy
// ---------------------------------------------------------------------------

const FIRST = ["Dana", "Marcus", "Priya", "Tom", "Keisha", "Leo", "Rachel", "Owen", "Mei", "Andre", "Grace", "Sam", "Nadia", "Ben", "Carmen", "Victor", "Hannah", "Ravi", "Erin", "Jonah"];
const LAST = ["Pell", "Okafor", "Rao", "Brandt", "Wells", "Moreau", "Tan", "Ruiz", "Hale", "Chen", "Abbott", "Lind", "Varga", "Osei", "Price", "Kemp", "Doyle", "Sato", "Fenn", "Ward"];
const CO: Record<string, string[]> = {
  office_manager: ["Harbor Lane Partners", "Fairmount Analytics", "Kestrel Design Group", "Northbank Insurance", "Lindell & Shaw", "Penrose Health Billing"],
  exec_admin: ["Calder Capital", "Brightwater Advisors", "Ostrander Holdings", "Vale Street Ventures"],
  corporate_events: ["Arden Biotech", "Quill Software", "Meridian Logistics", "Strata Engineering"],
  hr_people_ops: ["Cobalt Payroll", "Juniper Foods", "Tidewell Energy", "Haverford Freight"],
  education: ["Spruce Hill Academy", "Cedar Park School", "West Philly Learning Co-op", "Schuylkill Prep"],
  nonprofit_events: ["River Wards Food Pantry", "Kensington Arts Collective", "Germantown Youth League"],
  healthcare_practice: ["Rittenhouse Pediatrics", "Fitler Dental", "Market Street Physical Therapy"],
  property_mgmt: ["Bainbridge Residential", "Callowhill Lofts", "Spring Garden Flats"],
  law_admin: ["Okafor Brandt LLP", "Wells & Moreau", "Delancey Legal Group"],
};

const SIGN = (sender: string) => `\n\n${sender[0].toUpperCase()}${sender.slice(1)}\nOutreach Coordinator at Ben & Jerry's Philadelphia`;
const party = (o: OccasionFact) => (o.id === "resident_events" ? "a resident holiday event" : "your holiday party");

function copy(approach: string, touch: number, first: string, company: string, o: OccasionFact, lastMonth: string, sender: string, small: boolean): { subject: string; body: string } {
  const S = SIGN(sender);
  // Small groups are never emailed (Alina 2026-11-16); the cake is offered only in a reply.
  void small;
  const ask = "Reply with a date and a headcount and you'll have a quote the same day.";
  switch (approach) {
    case "question_opener":
      return touch === 1
        ? { subject: `${company}'s holiday party?`, body: `Hi ${first},\n\nIs ${company} doing a holiday party this year?\n\nIf so, we can bring a Hot Chocolate Float Party to it: we set up, scoop for everyone and clean up after.\n\nInterested? ${ask}${S}` }
        : { subject: `A December date for ${company}?`, body: `Hi ${first},\n\nHas ${company} picked a date for ${party(o)} yet?\n\nWe still have December afternoons open for Hot Chocolate Float Parties. We bring everything and clean up after.\n\n${ask}${S}` };
    case "pick_me_up":
      return { subject: "Ice cream at 3?", body: `Hi ${first},\n\nIf the 3pm slump just hit ${company}, picture the holiday party version: hot chocolate with a scoop of Ben & Jerry's on top, served by our crew.\n\nWe bring everything and clean up. Interested? ${ask}${S}` };
    case "holiday_gift":
      return { subject: "A Holiday Gift from us to you", body: `Hi ${first},\n\nThank you for having us at ${company} in ${lastMonth}. Here's a Holiday Gift: $100 off the same full-service catering for your next event, on any date. Just pay your deposit by December 31.\n\nAnd if you refer someone who books, you get another $100 off.${S}` };
    case "cold_pilot_a":
      return { subject: `Ice cream catering for ${company}`, body: `Hi ${first},\n\nWe're the Ben & Jerry's in Philadelphia, and we cater offices across the area: we bring everything, scoop for your team and clean up.\n\nFor ${party(o)}, this winter's favourite is the Hot Chocolate Float Party.\n\n${ask}${S}` };
    default:
      return {
        subject: "Ice cream catering for holiday events",
        body: `Hi ${first},\n\nWe're the Ben & Jerry's in Philadelphia, and we cater events across the area. Winter is coming: the cold-weather menu is hot chocolate floats, warm cookie and brownie sundaes and Belgian waffle sundaes. We bring everything, scoop for your guests and clean up.\n\nIf ${company} has a holiday party or a staff appreciation event coming up, I can turn a quote around the same day.${S}`,
      };
  }
}

const JUDGE_PASS: Record<string, string> = {
  holiday_letter: "Unchanged baseline; name and company correct.",
  cold_pilot_a: "Unchanged baseline; name and company correct.",
  question_opener: "One question, and it leads straight into the party and the ask.",
  pick_me_up: "The 3pm line is true when it lands, and it is one short thought.",
  holiday_gift: "The offer, the 31 December deadline and the referral credit agree.",
};

// ---------------------------------------------------------------------------
// The week
// ---------------------------------------------------------------------------

export function syntheticLoop(now: Date): LoopFacts {
  const r = rng(964);
  const weekStart = loopWeekStart(now);
  const today = todayEt(now);
  const year = Number(weekStart.slice(0, 4));
  const ranAt = new Date(Math.min(new Date(etAt(weekStart, 6, 2)).getTime(), now.getTime() - 40 * 60_000)).toISOString();
  const days = [0, 1, 2, 3, 4].map((i) => addDays(weekStart, i));
  const approaches: Record<string, ApproachFact> = Object.fromEntries(APPROACHES.map((a) => [a.id, { ...a, slots: a.slots ?? [] }]));

  const tests: TestFact[] = TEST_SEEDS.map((t) => {
    const arms: ArmFact[] = t.arms.map(([approachId, sends, replies, leads, bookings, status, since, reason]) => ({
      approachId,
      status,
      since: addDays(weekStart, since),
      reason,
      sends,
      reply: rate(replies, sends),
      lead: rate(leads, sends),
      booking: rate(bookings, sends),
      best: null,
      verdict: "learning",
      emailsThisWeek: 0,
    }));
    chanceBest(arms);
    for (const a of arms) a.verdict = verdictOf(a, approaches[a.approachId]?.baseline ?? a.reason.startsWith("The baseline"));
    return { id: t.id, tier: t.tier, factor: t.factor, question: t.question, arms, weekly: t.weekly, started: addDays(weekStart, t.started), why: t.why };
  });
  const testFor = (tier: "warm" | "cold") => tests.find((t) => t.tier === tier && t.factor === "approach")!;
  const timeTest = tests.find((t) => t.factor === "send time")!;

  const types: TypeFact[] = TYPES.map((t) => {
    const tier = t.key.startsWith("cold") ? "cold" : "warm";
    const test = testFor(tier);
    const share = t.week / test.weekly;
    // Per-type reads: this type's slice of the pooled arms (diagnostic only).
    const arms: ArmFact[] = test.arms
      .filter((a) => a.status === "live" || a.sends > 0)
      .map((a) => {
        const n = Math.round(a.sends * share);
        const k = Math.min(n, Math.round(a.reply.k * share + (r() - 0.5)));
        const l = Math.min(k, Math.round(a.lead.k * share + (r() - 0.5) * 0.6));
        return { ...a, sends: n, reply: rate(k, n), lead: rate(l, n), booking: rate(0, n), best: null, emailsThisWeek: 0 };
      });
    chanceBest(arms);
    for (const a of arms) a.verdict = verdictOf(a, approaches[a.approachId]?.baseline ?? false);
    return {
      key: t.key,
      tier,
      label: typeLabel(t.key),
      target: { ...t.target, aim: `${year}-${t.target.aim}` },
      upcoming: t.upcoming.map((o) => ({ ...o, aim: `${year + 1}-${o.aim}` })),
      emailsThisWeek: t.week,
      sentThisWeek: 0,
      ready: t.ready,
      // Alina 2026-11-16: no outreach to small groups; the cake is offered only in her reply draft.
      held: [...t.held.map(([reason, n]) => ({ reason, n })),
             ...(t.small ? [{ reason: "Under 40 guests last time: not emailed (the cake is offered only in a reply)", n: t.small }] : [])],
      adjusted: [],
      arms,
      mostly: null,
    };
  });

  // Drafts: each type's week over Monday to Friday, in the three slots.
  const drafts: DraftFact[] = [];
  let id = 1;
  for (const t of types) {
    const test = testFor(t.tier as "warm" | "cold");
    const baseId = test.arms.find((a) => a.verdict === "baseline")!.approachId;
    const live = test.arms.filter((a) => a.status === "live" && a.approachId !== baseId);
    const kind = t.key.split(":")[1];
    let small = t.adjusted[0]?.n ?? 0;
    for (let i = 0; i < t.emailsThisWeek; i++) {
      const pastCustomer = t.tier === "warm" && r() < 0.45;
      const baseline = r() < 0.2;
      let approachId = baseId;
      let slot = SLOTS[Math.floor(r() * 3)].id;
      if (!baseline) {
        const pool = live.filter((a) => a.approachId !== "holiday_gift" || pastCustomer);
        const w = (a: ArmFact) => (a.reply.k < 5 ? 0.35 : (a.best ?? 0)) + 0.05;
        let x = r() * pool.reduce((s, a) => s + w(a), 0);
        for (const a of pool) {
          x -= w(a);
          if (x <= 0) {
            approachId = a.approachId;
            break;
          }
        }
      }
      const ap = approaches[approachId];
      if (ap.slots.length) slot = ap.slots[0];
      const arm = test.arms.find((a) => a.approachId === approachId)!;
      arm.emailsThisWeek++;
      const typeArm = t.arms.find((a) => a.approachId === approachId);
      if (typeArm) typeArm.emailsThisWeek++;
      const slotArm = timeTest.arms.find((a) => a.approachId === slot)!;
      slotArm.emailsThisWeek++;
      const first = FIRST[Math.floor(r() * FIRST.length)];
      const last = LAST[Math.floor(r() * LAST.length)];
      const cos = CO[kind] ?? ["Walnut Street Group"];
      const company = cos[Math.floor(r() * cos.length)];
      const touch = t.tier === "cold" ? 1 : r() < 0.6 ? 1 : 2;
      const sendOn = days[Math.min(4, Math.floor(r() * 5))];
      const lastMonth = ["March", "May", "June", "September", "October"][Math.floor(r() * 5)];
      const mailbox = t.tier === "cold" ? ["sam", "lee", "jo"][id % 3] : ["jacob", "jake", "jakob"][id % 3];
      const isSmall = small > 0 && r() < 0.4;
      if (isSmall) small--;
      const c = copy(approachId, touch, first, company, t.target!, lastMonth, mailbox, isSmall);
      const est = r();
      const basis: DraftFact["why"]["basis"] = t.tier === "cold" ? (est < 0.15 ? "estimated" : "occasion") : est < 0.12 ? "estimated" : est < 0.3 ? "known" : "occasion";
      const status: DraftFact["status"] = sendOn < today ? "sent" : "planned";
      const eventDate = basis === "occasion" ? t.target!.aim : addDays(t.target!.aim, Math.floor(r() * 9) - 4);
      const sl = SLOTS.find((s) => s.id === slot)!;
      const [hh, mm] = sl.at.split(":").map(Number);
      const j = r();
      const judge: DraftFact["judge"] =
        j < 0.04
          ? { verdict: "rewritten", note: "First draft asked two questions; the judge sent it back and the rewrite asks one." }
          : j < 0.07
            ? { verdict: "rewritten", note: "The picture described a sundae bar but the ask booked hot chocolate floats; rewritten so they match." }
            : { verdict: "pass", note: JUDGE_PASS[approachId] ?? "Reads as one email with one ask." };
      drafts.push({
        id: String(id++),
        sendOn,
        touch,
        planned: t.tier === "cold" ? 1 : 2,
        type: t.key,
        approachId,
        assignedBy: baseline ? "baseline_quota" : "thompson",
        subject: c.subject,
        body: c.body,
        status,
        skipReason: null,
        mailbox: t.tier === "cold" ? `${mailbox}@cold-mail.example.com` : `${mailbox}@news.benjerryphilly.com`,
        person: { name: `${first} ${last}`, company, email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com` },
        why: {
          relationship: t.tier === "cold" ? "new to us" : pastCustomer ? `past customer (${lastMonth})` : "enquirer",
          occasion: basis === "occasion" ? t.target!.name : basis === "known" ? "Holiday party, the week of their booking last year" : "Holiday party (research)",
          eventDate,
          basis,
          source: basis === "occasion" ? "occasion_calendar" : basis === "known" ? "booking" : r() < 0.5 ? "public" : "linkedin",
          confidence: basis === "estimated" ? Math.round((0.5 + r() * 0.35) * 100) / 100 : null,
          evidence: basis === "estimated" ? `${company} posted photos of last year's holiday party on ${Number(eventDate.slice(8))} December.` : null,
        },
        prior: touch === 1 ? [] : [{ touch: 1, subject: copy(approachId, 1, first, company, t.target!, lastMonth, mailbox, false).subject, sentOn: addDays(sendOn, -7) }],
        slot,
        sendAt: etAt(sendOn, hh, mm),
        judge,
        pick: baseline
          ? `The ${ap.name}'s 20% share: some of every week go to the email we sent by hand, so the others have something to beat.`
          : arm.reply.k < 5
            ? `${ap.name} has under 5 replies, so it gets a fair share until there is something to judge.`
            : `The daily draw: each approach gets a share of the week in line with its chance of being the best (see the test).`,
      });
    }
    t.sentThisWeek = drafts.filter((d) => d.type === t.key && d.status === "sent").length;
    const counts = new Map<string, number>();
    for (const d of drafts.filter((x) => x.type === t.key)) counts.set(d.approachId, (counts.get(d.approachId) ?? 0) + 1);
    t.mostly = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  // One email the judge held for you.
  const heldOne = drafts.find((d) => d.type === "warm:education" && d.status === "planned");
  if (heldOne) {
    heldOne.status = "held";
    heldOne.judge = { verdict: "held", note: "Rewritten twice and still mentions a December budget to a school whose year ends in June. Held for you." };
  }

  const planned = drafts.length;
  const run = (wk: string, memo: string, decisions: RunFact["decisions"], asks: RunFact["asks"], approved: boolean, n: number): RunFact => ({
    weekStart: wk,
    createdAt: wk === weekStart ? ranAt : etAt(wk, 6, 4),
    check: { ok: true, text: "Scorer unchanged (SHA matches limits.toml) and every loop table present." },
    memo,
    decisions,
    asks,
    approvedAt: approved ? etAt(wk, 8, 40) : null,
    digestSentAt: wk === weekStart ? ranAt : etAt(wk, 6, 10),
    planned: n,
  });

  const runs: RunFact[] = [
    run(
      weekStart,
      "Started from what we sent by hand: the holiday letter's emails since August are now the baseline, so its rate is known and a new email needs far fewer sends to prove itself. Question first leads with past customers. I set Paint the party aside so the test settles in about half the time, and started a 3pm pick-me-up, sent only in the 3pm slot. Cold is sending again; at its reply rate it cannot settle a question on its own this season, so it tests the past-customer leader against the old cold email.",
      [
        { kind: "add", type: null, approachId: "pick_me_up", reason: "A new idea, not from your list: most office workers reach for a treat mid-afternoon. It only goes out at 3pm, so the email and its timing agree." },
        { kind: "retire", type: null, approachId: "hcf_picture", reason: "Set aside, not lost: four approaches split 120 emails a week too thin. With three, the test settles in about half the time." },
        { kind: "add", type: "cold:office_manager", approachId: "question_opener", reason: "Cold sends again. It borrows the past-customer leader rather than testing from scratch." },
        { kind: "hold", type: null, approachId: "question_opener", reason: "Leading, but under 95% chance of best." },
      ],
      [
        { id: "cap", text: "Raise the warm daily cap from 24 to 40? About 1,400 past customers and enquirers are ready and December's window closes in four weeks.", answered: false },
        { id: "occ", text: "Approve Lunar New Year for corporate event planners? The first send would be 4 January.", answered: false },
      ],
      false,
      planned,
    ),
    run(
      addDays(weekStart, -7),
      "Folded the $100 Holiday Gift into the loop for past customers who booked, so it competes with everything else instead of running on its own. Retired Year-end budget: schools replied that their year ends in June. Started the send-time test: everything so far went out around 10am.",
      [
        { kind: "add", type: null, approachId: "holiday_gift", reason: "The Offer lane's email, now one approach among the others." },
        { kind: "retire", type: null, approachId: "budget_close", reason: "Two schools replied 'our budget year ends in June'; offices no better than the letter." },
        { kind: "retire", type: null, approachId: "last_event_callback", reason: "1 reply in 151 emails." },
      ],
      [],
      true,
      118,
    ),
    run(
      addDays(weekStart, -14),
      "Started Your last event and Year-end budget alongside Question first and Paint the party.",
      [
        { kind: "add", type: null, approachId: "last_event_callback", reason: "A relationship opener; none of the live ones uses the booking history." },
        { kind: "add", type: null, approachId: "budget_close", reason: "A timing reason for December." },
      ],
      [],
      true,
      121,
    ),
    run(
      addDays(weekStart, -21),
      "The first loop week. The holiday letter is the baseline; Question first and Paint the party compete with it across every warm type.",
      [
        { kind: "add", type: null, approachId: "question_opener", reason: "From your research list: interest asks beat meeting asks on first contact." },
        { kind: "add", type: null, approachId: "hcf_picture", reason: "From your research list: sensory copy raises expected taste." },
      ],
      [],
      true,
      116,
    ),
  ];

  const judge = {
    passed: drafts.filter((d) => d.judge.verdict === "pass").length,
    rewritten: drafts.filter((d) => d.judge.verdict === "rewritten").length,
    held: drafts.filter((d) => d.judge.verdict === "held").length,
    youOverruled: 1,
  };

  return {
    synthetic: TAG,
    now: now.toISOString(),
    today,
    weekStart,
    gate: true,
    paused: null,
    run: runs[0],
    runs,
    types,
    cold: { enabled: true, ready: 2800 },
    tests,
    slots: Object.fromEntries(SLOTS.map((s) => [s.id, s])),
    history: [],
    judge,
    approaches,
    drafts,
    limits: {
      dailyCap: 24,
      coldDailyCap: 60,
      baselineShare: 0.2,
      maxLive: 3,
      coldEnabled: true,
      apolloCredits: 0,
      unsubPause: 0.02,
      minGuests: 40,
      holdBackMonths: 6,
      minDaysBeforeEvent: 14,
      never: [
        "An event under 14 days away (Fair Workweek: staff are scheduled two weeks out).",
        "A discount or promo code other than the offers listed below: Square discounts are set by Ben & Jerry's corporate.",
        "Anything about the person or company that research did not find.",
        "A fast day, solemn day or remembrance day as a reason to celebrate.",
        "Cold email from catering@.",
        "An email without a way to opt out.",
      ],
      leanToward: [
        "Say who we are: the Ben & Jerry's in Philadelphia, catering across the area.",
        "Say we bring everything, scoop for the guests and clean up.",
        "Offer a quote the same day.",
        "In winter, lead with the Hot Chocolate Float Party.",
        "One ask per email.",
        "Short: about 120 words or fewer.",
        "Don't point back at an earlier email ('following up', 'as I mentioned').",
      ],
      allowedOffers: ["Hot Chocolate Float Party", "$100 Holiday Gift (past customers who booked; deposit by 31 December)", "$100 Referral Credit"],
      approvedAsk: [],
      linkedinCap: 40,
      linkedinPause: 20,
      neverEmail: 0,
    },
    research: {
      viewsToday: 23,
      halt: null,
      estimates: [
        { company: "Arden Biotech", kind: "holiday party", date: `${year}-12-11`, source: "public", confidence: 0.8, evidenceUrl: "https://example.com/arden-news", evidence: "Last year's party photos posted 11 December.", foundAt: etAt(addDays(weekStart, -3), 10) },
        { company: "Kestrel Design Group", kind: "holiday party", date: `${year}-12-18`, source: "linkedin", confidence: 0.6, evidenceUrl: "https://example.com/kestrel-linkedin", evidence: "Company page: 'Holiday party at the studio, 18 Dec'.", foundAt: etAt(addDays(weekStart, -2), 11) },
        { company: "Spruce Hill Academy", kind: "holiday party", date: `${year}-12-17`, source: "public", confidence: 0.85, evidenceUrl: "https://example.com/spruce-calendar", evidence: "School calendar: staff holiday lunch 17 December.", foundAt: etAt(addDays(weekStart, -2), 14) },
        { company: "Quill Software", kind: "milestone", date: `${year + 1}-01-22`, source: "public", confidence: 0.7, evidenceUrl: "https://example.com/quill-10", evidence: "Founded January 2017; tenth anniversary next month.", foundAt: etAt(addDays(weekStart, -1), 9) },
        { company: "Cobalt Payroll", kind: "welcome", date: `${year + 1}-01-12`, source: "job_change", confidence: 0.5, evidenceUrl: "https://example.com/cobalt-hire", evidence: "New head of people started in November.", foundAt: etAt(addDays(weekStart, -1), 15) },
      ],
      accuracy: [
        { source: "public", checked: 3, medianDaysOff: 4 },
        { source: "linkedin", checked: 1, medianDaysOff: 9 },
        { source: "job_change", checked: 0, medianDaysOff: null },
      ],
    },
    notes: [
      { name: "Ruth Calloway", company: "Germantown Youth League", why: "Goodwill refund after a late arrival (October event).", since: etAt(addDays(weekStart, -10), 9), noteSentAt: null },
      { name: "Paul Ingram", company: "Lindell & Shaw", why: "Complained about a second email in one week.", since: etAt(addDays(weekStart, -20), 9), noteSentAt: etAt(addDays(weekStart, -17), 11) },
    ],
    volume: { ready: 4200, roomPerWeek: 420, warm: { ready: 1400, room: 120 }, cold: { ready: 2800, room: 300 } },
    unsub: { n: 2, sends: 412 },
    week: { replies: 7, leads: 3, bookings: 1, avg4: { replies: 5.5, leads: 2.25, bookings: 0.5 } },
    flagged: [],
  };
}
