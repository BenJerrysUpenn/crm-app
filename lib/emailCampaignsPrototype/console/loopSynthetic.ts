// PROTOTYPE (bj-finance #811 round 3), throwaway. A synthetic week of the
// weekly email loop, shaped like the 16 November 2026 rehearsal: 1,405 people
// ready, room for 300 a week, offices aimed at calendar year-end (16 Dec),
// schools and nonprofits at holiday party season (12 Dec). Three earlier
// weeks of history so the charts and verdicts have something to show.
//
// Every person and company here is invented. Every number is marked
// synthetic on screen. Nothing is read from or written to the database.

import {
  loopWeekStart,
  rate,
  todayEt,
  typeLabel,
  type ApproachFact,
  type ArmFact,
  type DraftFact,
  type LoopFacts,
  type OccasionFact,
  type RunFact,
  type TypeFact,
} from "./loop";

const TAG = "synthetic loop week (nothing has run live yet)";
const DAY = 86_400_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const addDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T12:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
/** 'YYYY-MM-DD' at hh:mm New York time (EST in winter), as ISO. */
const etAt = (ymd: string, h: number, m = 0) => new Date(`${ymd}T${String(h + 5).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`).toISOString();

export const SYN_APPROACHES: ApproachFact[] = [
  {
    id: "plain_offer",
    name: "Plain offer",
    family: "offer",
    opener: "Who we are and what we bring",
    structure: "who we are, what is included, the ask",
    ask: "a date and a headcount",
    length: "short",
    baseline: true,
    brief: "The unchanged baseline: the warm email Alina approved in October, rewritten per person only for name, company and occasion.",
    createdBy: "Alina (October warm email)",
    createdAt: "2026-10-26T14:00:00Z",
  },
  {
    id: "question_opener",
    name: "Question first",
    family: "question",
    opener: "One plain question about their plans",
    structure: "question, one line on the party, the ask",
    ask: "a date and a headcount",
    length: "short",
    baseline: false,
    brief: "Open with a question they can answer in one word, so a reply is easy. Then one line on the Hot Chocolate Float Party.",
    createdBy: "Claude, week 1",
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
    brief: "Lead with what the guests see and taste. Winter months only (your will-say list).",
    createdBy: "Claude, week 1",
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
    brief: "Past customers only: name the month we last scooped for them, from the booking, and offer to hold a date.",
    createdBy: "Claude, week 2",
    createdAt: "2026-11-02T14:00:00Z",
  },
  {
    id: "budget_close",
    name: "Year-end budget",
    family: "timing",
    opener: "Year-end budget left to spend",
    structure: "budget line, the party, the ask",
    ask: "a date and a headcount",
    length: "short",
    baseline: false,
    brief: "Offices with a calendar fiscal year: a thank-you for the team can use budget that would otherwise lapse on 31 December.",
    createdBy: "Claude, week 3",
    createdAt: "2026-11-09T14:00:00Z",
  },
];

const FY: OccasionFact = { id: "calendar_fy_end", name: "Calendar year-end", aim: "12-16", basis: "the middle of 1 to 31 December" };
const HOL: OccasionFact = { id: "holiday_party_season", name: "Holiday party season", aim: "12-12", basis: "the middle of 1 to 23 December" };
const VAL: OccasionFact = { id: "valentines_day", name: "Valentine's Day", aim: "02-14", basis: "fixed date" };
const EAD: OccasionFact = { id: "employee_appreciation_day", name: "Employee Appreciation Day", aim: "03-05", basis: "first Friday of March" };
const APD: OccasionFact = { id: "admin_professionals_day", name: "Administrative Professionals Day", aim: "04-21", basis: "Wednesday of the last full week of April" };
const TAW: OccasionFact = { id: "teacher_appreciation_week", name: "Teacher Appreciation Week", aim: "05-05", basis: "first full week of May" };
const VOL: OccasionFact = { id: "volunteer_week", name: "National Volunteer Week", aim: "04-21", basis: "third full week of April" };
const NUR: OccasionFact = { id: "nurses_week", name: "Nurses Week", aim: "05-09", basis: "6 to 12 May" };

type ArmSeed = [approach: string, sends: number, replies: number, leads: number, bookings: number, best: number | null, status?: ArmFact["status"]];

type TypeSeed = {
  key: string;
  target: OccasionFact;
  upcoming: OccasionFact[];
  week: number;
  ready: number;
  held: [string, number][];
  arms: ArmSeed[];
};

const TYPES: TypeSeed[] = [
  {
    key: "warm:office_manager",
    target: FY,
    upcoming: [VAL, EAD, APD],
    week: 72,
    ready: 388,
    held: [["Event under 14 days away (Fair Workweek)", 6], ["Held back 6 months after a closed-lost deal", 11], ["Group under 40 people: cake pointer instead", 9]],
    arms: [
      ["plain_offer", 172, 4, 2, 1, null],
      ["question_opener", 166, 7, 5, 1, 0.62],
      ["hcf_picture", 160, 5, 3, 0, 0.21],
      ["budget_close", 38, 1, 1, 0, 0.05],
      ["last_event_callback", 151, 1, 0, 0, 0.0, "retired"],
    ],
  },
  {
    key: "warm:exec_admin",
    target: FY,
    upcoming: [EAD, APD],
    week: 46,
    ready: 241,
    held: [["Held back 6 months after a closed-lost deal", 4]],
    arms: [
      ["plain_offer", 118, 2, 1, 0, null],
      ["question_opener", 112, 3, 2, 0, 0.38],
      ["hcf_picture", 109, 3, 2, 1, 0.47],
    ],
  },
  {
    key: "warm:corporate_events",
    target: FY,
    upcoming: [VAL, EAD],
    week: 38,
    ready: 196,
    held: [["Event under 14 days away (Fair Workweek)", 3]],
    arms: [
      ["plain_offer", 96, 2, 1, 0, null],
      ["hcf_picture", 91, 4, 3, 1, 0.74],
      ["last_event_callback", 64, 1, 0, 0, 0.12],
    ],
  },
  {
    key: "warm:hr_people_ops",
    target: FY,
    upcoming: [EAD, APD],
    week: 34,
    ready: 162,
    held: [],
    arms: [
      ["plain_offer", 81, 1, 0, 0, null],
      ["question_opener", 77, 2, 1, 0, 0.52],
      ["hcf_picture", 74, 1, 1, 0, 0.31],
    ],
  },
  {
    key: "warm:education",
    target: HOL,
    upcoming: [TAW],
    week: 40,
    ready: 187,
    held: [["Group under 40 people: cake pointer instead", 5]],
    arms: [
      ["plain_offer", 88, 3, 1, 1, null],
      ["question_opener", 84, 2, 1, 0, 0.3],
      ["hcf_picture", 80, 3, 2, 0, 0.44],
    ],
  },
  {
    key: "warm:nonprofit_events",
    target: HOL,
    upcoming: [VOL],
    week: 30,
    ready: 121,
    held: [["A personal note from you instead (refund)", 1]],
    arms: [
      ["plain_offer", 41, 1, 0, 0, null],
      ["question_opener", 39, 0, 0, 0, 0.33],
      ["hcf_picture", 38, 1, 1, 0, 0.33],
    ],
  },
  {
    key: "warm:healthcare_practice",
    target: FY,
    upcoming: [NUR],
    week: 22,
    ready: 74,
    held: [],
    arms: [
      ["plain_offer", 22, 0, 0, 0, null],
      ["question_opener", 20, 1, 0, 0, 0.35],
      ["hcf_picture", 19, 0, 0, 0, 0.3],
    ],
  },
  {
    key: "warm:property_mgmt",
    target: FY,
    upcoming: [VAL],
    week: 14,
    ready: 36,
    held: [],
    arms: [
      ["plain_offer", 12, 0, 0, 0, null],
      ["hcf_picture", 11, 1, 0, 0, 0.5],
    ],
  },
];

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
  property_mgmt: ["Bainbridge Residential", "Callowhill Lofts"],
};


function words(o: OccasionFact) {
  return o.id === "calendar_fy_end"
    ? { short: "year-end thank-you", phrase: "a year-end thank-you for the team", before: "the end of the year" }
    : { short: "holiday party", phrase: "your holiday party", before: "the holidays" };
}

function copy(approach: string, touch: number, first: string, company: string, o: OccasionFact, lastMonth: string, sender: string): { subject: string; body: string } {
  const w = words(o);
  const SIGN = `\n\n${sender[0].toUpperCase()}${sender.slice(1)}\nOutreach Coordinator at Ben & Jerry's Philadelphia`;
  switch (approach) {
    case "question_opener":
      return touch === 1
        ? {
            subject: `${company} before ${w.before}?`,
            body: `Hi ${first},\n\nIs ${company} doing anything for the team before ${w.before}?\n\nIf so, we can bring a Hot Chocolate Float Party to you: we set up, scoop for everyone and clean up. It works for 40 people or 400.\n\nReply with a date and a headcount and you'll have a quote the same day.${SIGN}`,
          }
        : {
            subject: `A December date for ${company}?`,
            body: `Hi ${first},\n\nHas ${company} set a date for ${o.id === "calendar_fy_end" ? "a year-end thank-you" : "its holiday party"} yet?\n\nWe still have December afternoons open for Hot Chocolate Float Parties. We bring everything and clean up after.\n\nSend a date and a headcount and I'll quote it the same day.${SIGN}`,
          };
    case "hcf_picture":
      return {
        subject: touch === 1 ? `Hot Chocolate Float Party for ${company}` : `Hot chocolate, ice cream, ${company}`,
        body: `Hi ${first},\n\nPicture hot chocolate with a scoop of Ben & Jerry's melting on top, served by our crew at ${company}'s ${w.short}.\n\nThat's our Hot Chocolate Float Party, and it's what Philadelphia offices book most in December. We bring everything, scoop for your guests and clean up.\n\nIf you have a date and a headcount, reply and I'll send a quote the same day.${SIGN}`,
      };
    case "last_event_callback":
      return {
        subject: `Ben & Jerry's at ${company} again?`,
        body: `Hi ${first},\n\nWe loved scooping for ${company} in ${lastMonth}. If you're planning ${w.phrase}, I can hold a date for you now while December still has room.\n\nThis winter we're also doing Hot Chocolate Float Parties: hot chocolate with a scoop on top.\n\nReply with a date and I'll hold it and send a quote the same day.${SIGN}`,
      };
    case "budget_close":
      return {
        subject: `Year-end budget at ${company}`,
        body: `Hi ${first},\n\nIf ${company} has team budget left before 31 December, a Hot Chocolate Float Party is an easy way to spend it on everyone at once.\n\nWe bring everything, scoop for your guests and clean up.\n\nSend a date and a headcount and you'll have a quote the same day.${SIGN}`,
      };
    default:
      return {
        subject: touch === 1 ? `Ice cream for ${company}'s ${w.short}` : `Hot chocolate and ice cream for ${company}`,
        body: `Hi ${first},\n\nWe're the Ben & Jerry's in Philadelphia, and we cater events across the area. For ${w.phrase} we bring everything, scoop for your guests and clean up after.\n\nThis time of year the favorite is our Hot Chocolate Float Party: hot chocolate with a scoop of ice cream on top, served at your office.\n\nSend me a date and a rough headcount and I'll have a quote back to you the same day.${SIGN}`,
      };
  }
}

export function syntheticLoop(now: Date): LoopFacts {
  const r = rng(964);
  const weekStart = loopWeekStart(now);
  const today = todayEt(now);
  const year = Number(weekStart.slice(0, 4));
  const ranAt = new Date(Math.min(new Date(etAt(weekStart, 6, 2)).getTime(), now.getTime() - 40 * 60_000)).toISOString();
  const days = [0, 1, 2, 3, 4].map((i) => addDays(weekStart, i));

  const types: TypeFact[] = TYPES.map((t) => {
    return {
      key: t.key,
      tier: "warm",
      label: typeLabel(t.key),
      target: { ...t.target, aim: `${year}-${t.target.aim}` },
      upcoming: t.upcoming.map((o) => ({ ...o, aim: `${year + 1}-${o.aim}` })),
      emailsThisWeek: t.week,
      sentThisWeek: 0,
      ready: t.ready,
      held: t.held.map(([reason, n]) => ({ reason, n })),
      arms: t.arms.map(([approachId, sends, replies, leads, bookings, best, status]) => ({
        approachId,
        status: status ?? "live",
        since: approachId === "budget_close" ? addDays(weekStart, -7) : approachId === "last_event_callback" ? addDays(weekStart, -14) : addDays(weekStart, -21),
        reason:
          status === "retired"
            ? "Chance of best fell to 0% after 151 sends (week 3)."
            : approachId === "plain_offer"
              ? "The baseline: 20% of every type's sends."
              : "Started by the Monday run.",
        sends,
        reply: rate(replies, sends),
        lead: rate(leads, sends),
        booking: rate(bookings, sends),
        best,
        verdict: approachId === "plain_offer" ? "baseline" : status === "retired" ? "retire" : sends < 150 ? "learning" : best !== null && best > 0.95 ? "crown" : best !== null && best < 0.05 ? "retire" : "live",
        emailsThisWeek: 0,
      })),
    };
  });

  // Drafts: each type's week spread over Monday to Friday.
  const drafts: DraftFact[] = [];
  let id = 1;
  for (const t of types) {
    const live = t.arms.filter((a) => a.status === "live");
    const kind = t.key.split(":")[1];
    for (let i = 0; i < t.emailsThisWeek; i++) {
      const baseline = r() < 0.2;
      let arm = live.find((a) => a.approachId === "plain_offer")!;
      if (!baseline) {
        const pool = live.filter((a) => a.approachId !== "plain_offer");
        const total = pool.reduce((s, a) => s + (a.best ?? 0.3) + 0.15, 0);
        let x = r() * total;
        for (const a of pool) {
          x -= (a.best ?? 0.3) + 0.15;
          if (x <= 0) {
            arm = a;
            break;
          }
        }
      }
      arm.emailsThisWeek++;
      const first = FIRST[Math.floor(r() * FIRST.length)];
      const last = LAST[Math.floor(r() * LAST.length)];
      const cos = CO[kind] ?? ["Walnut Street Group"];
      const company = cos[Math.floor(r() * cos.length)];
      const touch = r() < 0.55 ? 1 : r() < 0.7 ? 2 : 3;
      const sendOn = days[Math.min(4, Math.floor(r() * 5))];
      const pastCustomer = r() < 0.45;
      const lastMonth = ["March", "May", "June", "September", "October"][Math.floor(r() * 5)];
      const mailbox = ["jacob", "jake", "jakob"][id % 3];
      const c = copy(arm.approachId, touch, first, company, t.target!, lastMonth, mailbox);
      const est = r();
      const basis: DraftFact["why"]["basis"] = est < 0.12 ? "estimated" : est < 0.3 ? "known" : "occasion";
      const status: DraftFact["status"] = sendOn < today ? "sent" : "planned";
      const eventDate = basis === "occasion" ? t.target!.aim : addDays(t.target!.aim, Math.floor(r() * 9) - 4);
      drafts.push({
        id: String(id++),
        sendOn,
        touch,
        planned: 3,
        type: t.key,
        approachId: arm.approachId,
        assignedBy: baseline ? "baseline_quota" : "thompson",
        subject: c.subject,
        body: c.body,
        status,
        skipReason: null,
        mailbox: `${mailbox}@news.benjerryphilly.com`,
        person: { name: `${first} ${last}`, company, email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com` },
        why: {
          relationship: pastCustomer ? "past customer" : "enquirer",
          occasion: basis === "occasion" ? t.target!.name : basis === "known" ? "Holiday party, the week of their booking last year" : "Holiday party (research)",
          eventDate,
          basis,
          source: basis === "occasion" ? "occasion_calendar" : basis === "known" ? "booking" : r() < 0.5 ? "public" : "linkedin",
          confidence: basis === "estimated" ? Math.round((0.5 + r() * 0.35) * 100) / 100 : null,
          evidence: basis === "estimated" ? `${company} posted photos of last year's holiday party on ${Number(eventDate.slice(8))} December.` : null,
        },
        prior:
          touch === 1
            ? []
            : Array.from({ length: touch - 1 }, (_, k) => ({
                touch: k + 1,
                subject: copy(arm.approachId, k + 1, first, company, t.target!, lastMonth, mailbox).subject,
                sentOn: addDays(sendOn, -7 * (touch - 1 - k)),
              })),
      });
    }
    t.sentThisWeek = drafts.filter((d) => d.type === t.key && d.status === "sent").length;
  }
  // Baseline's chance of best: whatever the others leave.
  for (const t of types) {
    const others = t.arms.filter((a) => a.status === "live" && a.approachId !== "plain_offer").reduce((s, a) => s + (a.best ?? 0), 0);
    const b = t.arms.find((a) => a.approachId === "plain_offer");
    if (b) b.best = Math.max(0, Math.round((1 - Math.min(1, others)) * 100) / 100);
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
      "Office managers answer the short question opener best so far: 5 leads in 166 emails against 2 in 172 for the baseline, a 62% chance it is the best of the four. It is still too early to crown it. The new year-end budget approach has only 38 emails, so it keeps a fair share this week. Volume is the limit, not copy: 1,405 people are ready and the mailboxes have room for 300, so most of December's window goes unused unless the daily cap rises.",
      [
        { kind: "hold", type: "warm:office_manager", approachId: "question_opener", reason: "62% chance of best after 166 emails; crowning needs 95%." },
        { kind: "hold", type: "warm:corporate_events", approachId: "hcf_picture", reason: "74% chance of best after 91 emails; under 150, so no verdict yet." },
        { kind: "hold", type: "warm:office_manager", approachId: "budget_close", reason: "Started last week; 38 emails is too few to judge." },
      ],
      [
        { id: "cap", text: "Raise the daily cap from 60 to 90? 1,405 people are ready and the room is 300 a week; at 60 a day about 700 miss the December window.", answered: false },
        { id: "occ", text: "Approve Lunar New Year (rated ask) for corporate event planners? The first send would be 4 January.", answered: false },
      ],
      false,
      planned,
    ),
    run(
      addDays(weekStart, -7),
      "Retired 'Your last event' for office managers: 1 reply and no leads in 151 emails, under a 1% chance of best. Started 'Year-end budget' in its place for office managers only, since their fiscal year ends with the calendar. Schools and nonprofits move to holiday party season this week.",
      [
        { kind: "retire", type: "warm:office_manager", approachId: "last_event_callback", reason: "0 leads in 151 emails; chance of best under 1%." },
        { kind: "add", type: "warm:office_manager", approachId: "budget_close", reason: "Differs in opener (budget) from every live approach." },
      ],
      [],
      true,
      301,
    ),
    run(
      addDays(weekStart, -14),
      "First full week of scores. Replies come in at about the rate of the October warm email. Started 'Your last event' for office managers and corporate event planners, which only past customers receive.",
      [{ kind: "add", type: "warm:office_manager", approachId: "last_event_callback", reason: "A relationship opener; none of the live ones uses the booking history." }],
      [],
      true,
      298,
    ),
    run(
      addDays(weekStart, -21),
      "The first loop week. Three approaches per type: the October warm email as the baseline, a question opener and the Hot Chocolate Float Party picture. Every type gets an equal share until there are replies to go on.",
      [
        { kind: "add", type: null, approachId: "question_opener", reason: "Opener differs from the baseline." },
        { kind: "add", type: null, approachId: "hcf_picture", reason: "Opener and length differ from the baseline." },
      ],
      [],
      true,
      292,
    ),
  ];

  const approaches = Object.fromEntries(SYN_APPROACHES.map((a) => [a.id, a]));
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
    cold: { enabled: false, ready: 2771 },
    approaches,
    drafts,
    limits: {
      dailyCap: 60,
      baselineShare: 0.2,
      maxLive: 4,
      coldEnabled: false,
      apolloCredits: 0,
      unsubPause: 0.02,
      minGuests: 40,
      holdBackMonths: 6,
      minDaysBeforeEvent: 14,
      willSay: [
        "Who we are: the Ben & Jerry's in Philadelphia, catering events across the area.",
        "We bring everything, scoop for the guests, and clean up.",
        "A quote the same day when they reply with a date and a headcount.",
        "In winter months, lead with the Hot Chocolate Float Party.",
      ],
      wontSay: [
        "Any discount code or promo code: Square discounts are set by Ben & Jerry's corporate.",
        "Any reference to an earlier email (no 'as I mentioned', 'following up', 'bumping this').",
        "Any claim about the person or company that research did not find.",
        "Fast days, solemn days or remembrance days, as a reason to celebrate or otherwise.",
      ],
      allowedOffers: ["Hot Chocolate Float Party"],
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
    volume: { ready: 1405, roomPerWeek: 300 },
    unsub: { n: 2, sends: 412 },
    week: { replies: 7, leads: 3, bookings: 1, avg4: { replies: 5.5, leads: 2.25, bookings: 0.5 } },
    flagged: [],
  };
}
