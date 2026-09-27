// PROTOTYPE — Email campaigns tab (branch prototype/email-campaigns). Throwaway.
//
// Question this answers: "does one screen let the owners see and manage the
// whole email SYSTEM (tiers, categories, sequences, capacity) and drill into
// the PEOPLE flowing through it?"
//
// Pure functions only: rows in, payload out. Nothing here writes anywhere.
// There are no tier/segment columns yet (bj-finance #438), so every tier and
// warm/offer category below is DERIVED here from existing columns. Anything
// the database cannot tell us is a named constant tagged "static" or
// "assumed" and rendered with that tag in the UI.

export type Tag = "live" | "derived" | "static" | "mock";

export type ProspectRow = {
  id: number;
  name: string | null;
  company: string | null;
  email: string | null;
  status: string;
  engine: string | null;
  category: string | null;
  ever_booked: boolean;
  last_event_date: string | null;
  marketing_opt_in: boolean;
  last_outreach_at: string | null;
  verify_status: string | null;
};

export type DealRow = {
  contact_email: string | null;
  event_type: string | null;
  stage: string | null;
  event_date: string | null;
  created_at: string | null;
  last_outbound_at: string | null;
  source: string | null;
};

export type MailboxRow = {
  address: string;
  daily_allowance: number;
  frozen: boolean;
};

export type RawData = {
  prospects: ProspectRow[];
  deals: DealRow[];
  suppressedEmails: string[];
  blockedDomains: string[];
  mailboxes: MailboxRow[];
};

export type TierKey = "cold" | "warm" | "offer";
export type Bucket = "queue" | "in_sequence" | "resting" | "suppressed" | "unaccounted";

export type Person = {
  id: number;
  name: string;
  email: string | null;
  status: string;
  last_touch: string | null;
  why: string; // sub-reason inside the bucket, e.g. "finished sequence"
};

export type CategoryStat = {
  key: string;
  label: string;
  tag: Tag;
  total: number;
  counts: Record<Bucket, number>;
  sample: Record<Bucket, Person[]>; // capped, newest touch first
  queueSplit?: { label: string; n: number }[];
};

export type TierPayload = {
  key: TierKey;
  label: string;
  blurb: string;
  definition: string;
  everyone: CategoryStat;
  categories: CategoryStat[];
  sequence: {
    name: string;
    steps: number;
    url: string | null;
    tag: Tag;
    note: string;
  };
  restingReasons: { why: string; n: number; due: number }[];
  restingDue: number;
  volume: {
    period: "day" | "month";
    tag: Tag;
    firstTouches: number;
    followUps: number;
    retouches: number;
    demand: number;
    capacity: number;
    capacityNote: string;
    perMailbox: number;
    mailboxes: number;
    mailboxesNeeded: number;
    assumptions: string[];
  };
};

export type Payload = {
  generated_at: string;
  tiers: TierPayload[];
  outsideTiers: number;
  totals: { prospects: number; suppressionList: number };
  notes: string[];
};

// --- static / assumed values (rendered with their tag) -----------------------

// Apollo, 2026-09-27: the only cold sequence. Not called from the app.
export const COLD_SEQUENCE = {
  name: "Cold Pilot A",
  steps: 1,
  url: "https://app.apollo.io#/sequences/6a8e3e0efc576b00100b1f93",
  contacts: 0,
  active: false,
};
// Cold lane mailboxes live in Apollo (phillyicecreamcatering.com: alina@,
// alana@, anastasia@), 30/day each per the Apollo mailbox settings.
export const COLD_MAILBOXES = 3;
export const COLD_PER_MAILBOX_DAY = 30;
// warm_sender's OUTREACH_DAILY_CAP default; the droplet env is not readable
// from Vercel.
export const WARM_GLOBAL_CAP_DAY = 20;
export const WEEKDAYS_PER_MONTH = 21;
export const WARM_TEMPLATE_URL =
  "https://github.com/BenJerrysUpenn/Catering-Manager/blob/main/outreach/warm_sender.py";

// A person counts as "in sequence" for this many days after their last send;
// after that a single-step sequence is finished and they are resting. Assumed:
// the database has no "sequence finished" state.
export const IN_SEQUENCE_DAYS: Record<TierKey, number> = { cold: 14, warm: 7, offer: 7 };
// Re-touch cadence for resting people ("due"). Assumed: warm_sender is
// single-touch and has no re-contact clock. 60 days matches the existing
// outreach_recontact_queue view.
export const RETOUCH_DAYS: Record<TierKey, number> = { cold: 90, warm: 60, offer: 30 };
// Horizon over which the queue should drain (first touches). Assumed.
export const QUEUE_HORIZON: Record<TierKey, number> = { cold: 90, warm: 3, offer: 3 };

const SAMPLE_CAP = 60;

// --- event type buckets (derived from dirty free-text deals.event_type) ------

const EVENT_BUCKETS: { key: string; label: string; re: RegExp }[] = [
  { key: "corporate", label: "Corporate & office", re: /employee|corporate|appreciation|meeting|ice cream social|grand opening|holiday|office|client|conference|staff/ },
  { key: "wedding", label: "Weddings & showers", re: /wedding|bridal|engagement|rehearsal/ },
  { key: "school", label: "Graduation & school", re: /grad|school|prom|college|university|campus/ },
  { key: "family", label: "Birthdays & family", re: /birthday|baby|family|gender|mitzvah|baptism|communion|anniversary|reunion|bbq|block party|party|celebration of life/ },
  { key: "community", label: "Fundraisers & festivals", re: /fundraiser|festival|church|community|fair/ },
  { key: "cake", label: "Cake orders", re: /cake/ },
];

export function eventBucket(eventType: string | null | undefined): { key: string; label: string } {
  const t = (eventType ?? "").toLowerCase().trim();
  if (!t || t.startsWith("--")) return { key: "unknown_event", label: "Event type unknown" };
  for (const b of EVENT_BUCKETS) if (b.re.test(t)) return b;
  return { key: "other_event", label: "Other events" };
}

const COLD_LABELS: Record<string, string> = {
  law_admin: "Law firm admin",
  property_mgmt: "Property management",
  office_manager: "Office managers",
  hr_people_ops: "HR & people ops",
  exec_admin: "Executive assistants",
  corporate_events: "Corporate events",
  wedding_trade: "Wedding trade",
  education: "Education",
  healthcare_practice: "Healthcare practices",
  nonprofit_events: "Nonprofit events",
  coworking: "Coworking",
};

const BOOKED_STAGES = new Set(["Event Complete", "Booked Paid", "Booked Unpaid"]);

// --- compute -----------------------------------------------------------------

function emptyCounts(): Record<Bucket, number> {
  return { queue: 0, in_sequence: 0, resting: 0, suppressed: 0, unaccounted: 0 };
}
function emptySample(): Record<Bucket, Person[]> {
  return { queue: [], in_sequence: [], resting: [], suppressed: [], unaccounted: [] };
}
function newCat(key: string, label: string, tag: Tag): CategoryStat {
  return { key, label, tag, total: 0, counts: emptyCounts(), sample: emptySample() };
}

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function compute(data: RawData, now: Date): Payload {
  const nowMs = now.getTime();
  const DAY = 86_400_000;
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
  const twelveMonthsAgoISO = twelveMonthsAgo.toISOString().slice(0, 10);

  const suppressed = new Set(data.suppressedEmails.map(lc));
  const blocked = new Set(data.blockedDomains.map(lc));

  // outreach_talked_recently, replicated (the view is not granted to the app).
  const talkedRecently = new Set<string>();
  // Latest deal per email, and latest BOOKED deal per email.
  const latestDeal = new Map<string, DealRow>();
  const latestBooked = new Map<string, DealRow>();
  for (const d of data.deals) {
    const e = lc(d.contact_email);
    if (!e) continue;
    if (
      (d.source !== "migrated" && (d.created_at ?? "") >= "2026-05-01") ||
      (d.last_outbound_at ?? "") >= "2026-05-01"
    )
      talkedRecently.add(e);
    const key = d.event_date ?? d.created_at ?? "";
    const prev = latestDeal.get(e);
    if (!prev || key > (prev.event_date ?? prev.created_at ?? "")) latestDeal.set(e, d);
    if (d.stage && BOOKED_STAGES.has(d.stage)) {
      const pb = latestBooked.get(e);
      if (!pb || key > (pb.event_date ?? pb.created_at ?? "")) latestBooked.set(e, d);
    }
  }

  type Acc = {
    everyone: CategoryStat;
    cats: Map<string, CategoryStat>;
    resting: Map<string, { n: number; due: number }>;
    restingDue: number;
    queueReady: number;
    queueReveal: number;
  };
  const tiers: Record<TierKey, Acc> = {
    cold: { everyone: newCat("everyone", "Everyone", "live"), cats: new Map(), resting: new Map(), restingDue: 0, queueReady: 0, queueReveal: 0 },
    warm: { everyone: newCat("everyone", "Everyone", "derived"), cats: new Map(), resting: new Map(), restingDue: 0, queueReady: 0, queueReveal: 0 },
    offer: { everyone: newCat("everyone", "Everyone", "derived"), cats: new Map(), resting: new Map(), restingDue: 0, queueReady: 0, queueReveal: 0 },
  };
  // Seed cold categories so empty segments still show.
  for (const [k, l] of Object.entries(COLD_LABELS)) tiers.cold.cats.set(k, newCat(k, l, "live"));

  let outside = 0;

  for (const p of data.prospects) {
    const email = lc(p.email);
    // Tier
    let tier: TierKey;
    if (p.engine === "cold") tier = "cold";
    else if (p.engine === "warm") {
      const recentBooker = p.ever_booked && (p.last_event_date ?? "") >= twelveMonthsAgoISO;
      tier = p.marketing_opt_in || recentBooker ? "offer" : "warm";
    } else {
      outside++;
      continue;
    }
    const acc = tiers[tier];

    // Category
    let catKey: string;
    let catLabel: string;
    if (tier === "cold") {
      catKey = p.category ?? "uncategorised";
      catLabel = COLD_LABELS[catKey] ?? "Uncategorised";
    } else if (tier === "warm") {
      if (p.ever_booked) {
        catKey = "past_booker";
        catLabel = "Past bookers (12 mo+)";
      } else {
        const d = latestDeal.get(email);
        if (!d) {
          catKey = "no_deal";
          catLabel = "Salesforce lead, no deal on file";
        } else {
          const b = eventBucket(d.event_type);
          catKey = b.key;
          catLabel = `Enquired: ${b.label}`;
        }
      }
    } else {
      const d = latestBooked.get(email) ?? latestDeal.get(email);
      const b = eventBucket(d?.event_type);
      catKey = b.key;
      catLabel = b.label;
    }
    let cat = acc.cats.get(catKey);
    if (!cat) {
      cat = newCat(catKey, catLabel, tier === "cold" ? "live" : "derived");
      acc.cats.set(catKey, cat);
    }

    // Bucket (the state machine the owners described)
    const touchedMs = p.last_outreach_at ? Date.parse(p.last_outreach_at) : NaN;
    const ageDays = Number.isNaN(touchedMs) ? Infinity : (nowMs - touchedMs) / DAY;
    let bucket: Bucket;
    let why: string;
    const domain = email.split("@")[1] ?? "";
    if (p.status === "suppressed" || p.status === "dead" || (email && suppressed.has(email))) {
      bucket = "suppressed";
      why = p.status === "suppressed" ? "status suppressed" : email && suppressed.has(email) ? "on suppression list" : "dead";
    } else if (p.status === "sequenced" && ageDays <= IN_SEQUENCE_DAYS[tier]) {
      bucket = "in_sequence";
      why = `sent ${Math.floor(ageDays)}d ago`;
    } else if (tier === "cold" && ["raw", "enriched", "queued"].includes(p.status) && !p.last_outreach_at) {
      bucket = "queue";
      why = p.email ? "email revealed, ready" : "needs email reveal";
      if (p.email) acc.queueReady++;
      else acc.queueReveal++;
    } else if (
      tier !== "cold" &&
      p.status === "raw" &&
      !p.last_outreach_at &&
      email &&
      !["invalid", "disposable"].includes(p.verify_status ?? "") &&
      !talkedRecently.has(email) &&
      !blocked.has(domain)
    ) {
      bucket = "queue";
      why = "warm_sender eligible";
    } else if (p.status === "sequenced" && p.last_outreach_at) {
      bucket = "resting";
      why = "finished sequence";
    } else if (p.status === "replied" || p.status === "handed_off") {
      bucket = "resting";
      why = "replied / handed off";
    } else if (p.status === "called_lost") {
      bucket = "resting";
      why = "called, lost";
    } else if (p.status === "raw" && p.last_outreach_at) {
      bucket = "resting";
      why = "touched, back to raw";
    } else if (tier !== "cold" && p.status === "raw" && !p.last_outreach_at && email && blocked.has(domain)) {
      bucket = "resting";
      why = "held: blocked provider";
    } else if (tier !== "cold" && p.status === "raw" && !p.last_outreach_at && email && talkedRecently.has(email)) {
      bucket = "resting";
      why = "held: talked since May";
    } else if (tier !== "cold" && p.status === "raw" && !p.last_outreach_at && ["invalid", "disposable"].includes(p.verify_status ?? "")) {
      bucket = "resting";
      why = "held: bad email";
    } else {
      bucket = "unaccounted";
      why = `status=${p.status}${p.last_outreach_at ? ", touched" : ", never touched"}${email ? "" : ", no email"}`;
    }

    if (bucket === "resting") {
      const r = acc.resting.get(why) ?? { n: 0, due: 0 };
      r.n++;
      const isDue = !why.startsWith("held") && ageDays >= RETOUCH_DAYS[tier];
      if (isDue) {
        r.due++;
        acc.restingDue++;
      }
      acc.resting.set(why, r);
    }

    const person: Person = {
      id: p.id,
      name: p.name || p.company || "(no name)",
      email: p.email,
      status: p.status,
      last_touch: p.last_outreach_at,
      why,
    };
    for (const c of [acc.everyone, cat]) {
      c.total++;
      c.counts[bucket]++;
      c.sample[bucket].push(person);
    }
  }

  // Sort samples newest touch first, cap.
  const finish = (c: CategoryStat) => {
    for (const b of Object.keys(c.sample) as Bucket[]) {
      c.sample[b].sort((a, b2) => (b2.last_touch ?? "").localeCompare(a.last_touch ?? ""));
      c.sample[b] = c.sample[b].slice(0, SAMPLE_CAP);
    }
    return c;
  };

  const warmMailboxes = data.mailboxes.filter((m) => !m.frozen);
  const warmPerMailbox = warmMailboxes[0]?.daily_allowance ?? 33;
  const warmCapDay = Math.min(
    warmMailboxes.reduce((s, m) => s + m.daily_allowance, 0),
    WARM_GLOBAL_CAP_DAY,
  );

  const build = (key: TierKey): TierPayload => {
    const acc = tiers[key];
    const categories = Array.from(acc.cats.values())
      .map(finish)
      .sort((a, b) => b.total - a.total);
    const everyone = finish(acc.everyone);
    if (key === "cold")
      everyone.queueSplit = [
        { label: "ready (email revealed)", n: acc.queueReady },
        { label: "need reveal (Apollo credits)", n: acc.queueReveal },
      ];

    const steps = key === "offer" ? 0 : 1;
    const inSeq = everyone.counts.in_sequence;
    const queue = everyone.counts.queue;
    const period: "day" | "month" = key === "cold" ? "day" : "month";
    const firstTouches = Math.ceil(queue / QUEUE_HORIZON[key]);
    const followUps = Math.ceil(inSeq * Math.max(steps - 1, 0));
    const retouches = acc.restingDue;
    const demand = firstTouches + followUps + retouches;

    let capacity: number;
    let capacityNote: string;
    let perMailbox: number;
    let mailboxes: number;
    if (key === "cold") {
      mailboxes = COLD_MAILBOXES;
      perMailbox = COLD_PER_MAILBOX_DAY;
      capacity = mailboxes * perMailbox;
      capacityNote = `${mailboxes} Apollo mailboxes × ${perMailbox}/day (static). Sequence inactive, so actual sends today = 0.`;
    } else if (key === "warm") {
      mailboxes = warmMailboxes.length;
      perMailbox = warmPerMailbox * WEEKDAYS_PER_MONTH;
      capacity = warmCapDay * WEEKDAYS_PER_MONTH;
      capacityNote = `${mailboxes} news.* mailboxes × ${warmPerMailbox}/day (live) = ${mailboxes * warmPerMailbox}/day, but OUTREACH_DAILY_CAP ${WARM_GLOBAL_CAP_DAY}/day (static) is the ceiling × ${WEEKDAYS_PER_MONTH} weekdays.`;
    } else {
      mailboxes = 0;
      perMailbox = warmPerMailbox * WEEKDAYS_PER_MONTH;
      capacity = 0;
      capacityNote =
        "No offer lane exists. Today warm_sender mails offer-tier people from the warm mailboxes with the warm template (mock: 0 dedicated capacity).";
    }
    const mailboxesNeeded = perMailbox > 0 ? Math.ceil(demand / perMailbox) : 0;

    const meta: Record<TierKey, { label: string; blurb: string; definition: string }> = {
      cold: {
        label: "Cold",
        blurb: "Top of funnel",
        definition: "Apollo prospects who never contacted us (engine = cold).",
      },
      warm: {
        label: "Warm",
        blurb: "Middle of funnel",
        definition:
          "Enquired before, or booked more than 12 months ago and not opted in (engine = warm, not in Offer).",
      },
      offer: {
        label: "Offer",
        blurb: "Bottom of funnel",
        definition:
          "Booked in the last 12 months (last_event_date) or marketing_opt_in = true.",
      },
    };

    return {
      key,
      ...meta[key],
      everyone,
      categories,
      sequence:
        key === "cold"
          ? {
              name: COLD_SEQUENCE.name,
              steps: COLD_SEQUENCE.steps,
              url: COLD_SEQUENCE.url,
              tag: "static",
              note: `${COLD_SEQUENCE.steps} step, ${COLD_SEQUENCE.contacts} contacts, ${COLD_SEQUENCE.active ? "active" : "inactive"} (Apollo, 2026-09-27). Same sequence for every segment.`,
            }
          : key === "warm"
            ? {
                name: "warm_sender template",
                steps: 1,
                url: WARM_TEMPLATE_URL,
                tag: "static",
                note: 'Single touch, subject "Ice cream catering for holiday events". No follow-up step and no re-contact clock.',
              }
            : {
                name: "No offer sequence yet",
                steps: 0,
                url: null,
                tag: "mock",
                note: "Placeholder. Offers may go through Kit; nothing is wired.",
              },
      restingReasons: Array.from(acc.resting.entries())
        .map(([why, v]) => ({ why, n: v.n, due: v.due }))
        .sort((a, b) => b.n - a.n),
      restingDue: acc.restingDue,
      volume: {
        period,
        tag: "derived",
        firstTouches,
        followUps,
        retouches,
        demand,
        capacity,
        capacityNote,
        perMailbox,
        mailboxes,
        mailboxesNeeded,
        assumptions: [
          `First touches: queue drained over ${QUEUE_HORIZON[key]} ${period}s (assumed).`,
          `In sequence = sent within ${IN_SEQUENCE_DAYS[key]} days (assumed); follow-ups = remaining steps.`,
          `Re-touches: resting people whose last touch is ${RETOUCH_DAYS[key]}+ days old (assumed cadence), all due now.`,
        ],
      },
    };
  };

  return {
    generated_at: now.toISOString(),
    tiers: [build("cold"), build("warm"), build("offer")],
    outsideTiers: outside,
    totals: { prospects: data.prospects.length, suppressionList: suppressed.size },
    notes: [
      "Tiers and warm/offer categories are derived in this page's code; there are no tier or segment columns yet (bj-finance #438).",
      "Cold categories are the live outreach_prospects.category values (Apollo segments).",
      "The Offer tier is carved out of engine = warm, so warm_sender treats offer people as warm today.",
    ],
  };
}
