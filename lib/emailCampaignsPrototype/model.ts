// PROTOTYPE — Email campaigns tab (branch prototype/email-campaigns). Throwaway.
//
// Question this answers: "does one screen let the owners see and manage the
// whole email SYSTEM (tiers, categories, sequences, capacity) and drill into
// the PEOPLE flowing through it?"
//
// Pure functions only: rows in, payload out. Nothing here writes anywhere.
// There are no tier/segment columns yet (bj-finance #438), so every tier and
// warm/offer category below is DERIVED here from existing columns. Anything
// the database cannot tell us is a named constant tagged "static" or "mock".
//
// v2 (owner review 2026-09-27):
// - Suppressed / opted-out people are dropped BEFORE counting, so every number
//   on screen is simply "people in it". The accounting invariant is still
//   checked here (`TierPayload.check`); the UI shows nothing unless it breaks.
// - States are plain language: Up next / Just emailed / Resting (+ Held).
//   "Up next" includes people who are due again, and "due again" depends on
//   the cadence the owner picks in the UI, so the model ships the age (days
//   since last email) of everyone who can come due, and the client splits
//   them between Up next and Resting.
// - Volume is "reach everyone in the tier once per cadence"; the model ships
//   the capacity inputs and the client does the arithmetic per cadence.

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

// Internal buckets. The UI folds them into the owner's states:
//   Up next      = fresh + (dueable whose age >= cadence period)
//   Just emailed = just_emailed
//   Resting      = resting + held + (dueable whose age < cadence period)
//   Held         = held (shown under Resting)
//   unaccounted  = never shown unless > 0 (then one red line)
export type Bucket = "fresh" | "just_emailed" | "dueable" | "resting" | "held" | "unaccounted";
const BUCKETS: Bucket[] = ["fresh", "just_emailed", "dueable", "resting", "held", "unaccounted"];

export type Person = {
  id: number;
  name: string;
  email: string | null;
  status: string;
  last_touch: string | null;
  age_days: number | null; // whole days since last email
  why: string; // sub-reason, e.g. "never emailed", "held: blocked provider"
};

export type CategoryStat = {
  key: string;
  label: string;
  tag: Tag;
  total: number; // people in it; suppressed already excluded
  n: Record<Bucket, number>;
  // Days since last email for every "dueable" person, ascending. The client
  // counts how many are >= the cadence period to split Up next / Resting.
  dueAges: number[];
  sample: Record<Exclude<Bucket, "dueable">, Person[]> & {
    dueOldest: Person[];
    dueNewest: Person[];
  };
  heldReasons: { why: string; label: string; n: number }[];
  upNextSplit?: { label: string; n: number }[];
  sources?: { label: string; n: number; tag: Tag }[];
};

export type Cadence = "daily" | "weekly" | "biweekly" | "monthly" | "quarterly";

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
  defaultCadence: Cadence;
  capacity: {
    unit: "weekday" | "month";
    mailboxes: number;
    perMailboxDay: number;
    capDay: number | null; // a global daily cap that binds before mailboxes
    tag: Tag;
    source: string;
  };
  // Invariant, computed here, rendered only when broken.
  check: { suppressed: number; unaccounted: number; ok: boolean };
};

export type Payload = {
  generated_at: string;
  tiers: TierPayload[];
  totals: { prospects: number };
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
export const WEEKDAYS_PER_WEEK = 5;
export const WEEKDAYS_PER_MONTH = 21;
export const WARM_TEMPLATE_URL =
  "https://github.com/BenJerrysUpenn/Catering-Manager/blob/main/outreach/warm_sender.py";

// "Just emailed" = emailed within this many days: the window for replies and
// a follow-up call. Owner definition, same for every tier.
export const JUST_EMAILED_DAYS = 7;

export const CADENCES: {
  key: Cadence;
  label: string;
  periodDays: number; // calendar days before someone is due again
  weekdays: number; // sending weekdays in one period
}[] = [
  { key: "daily", label: "daily (capped)", periodDays: 1, weekdays: 1 },
  { key: "weekly", label: "once a week", periodDays: 7, weekdays: 5 },
  { key: "biweekly", label: "every 2 weeks", periodDays: 14, weekdays: 10 },
  { key: "monthly", label: "once a month", periodDays: 30, weekdays: 21 },
  { key: "quarterly", label: "once a quarter", periodDays: 91, weekdays: 63 },
];
export const DEFAULT_CADENCE: Record<TierKey, Cadence> = {
  cold: "weekly",
  warm: "monthly",
  offer: "monthly",
};

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

const HELD_LABELS: Record<string, string> = {
  "held: blocked provider": "Yahoo/Microsoft blocked until warm mailboxes are ready",
  "held: talked since May": "talked to since May, kept out of the blast",
  "held: bad email": "email address failed verification",
};

const BOOKED_STAGES = new Set(["Event Complete", "Booked Paid", "Booked Unpaid"]);

// --- helpers used by the client too -----------------------------------------

export function cadenceOf(key: Cadence) {
  return CADENCES.find((c) => c.key === key) ?? CADENCES[1];
}

/** Count of ascending `ages` that are >= `min`. */
export function countAtLeast(ages: number[], min: number): number {
  let lo = 0;
  let hi = ages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ages[mid] < min) lo = mid + 1;
    else hi = mid;
  }
  return ages.length - lo;
}

/** The owner's states for one card at one cadence. */
export function statesAt(c: CategoryStat, cadence: Cadence) {
  const due = countAtLeast(c.dueAges, cadenceOf(cadence).periodDays);
  const notDue = c.n.dueable - due;
  return {
    upNext: c.n.fresh + due,
    dueAgain: due,
    justEmailed: c.n.just_emailed,
    resting: c.n.resting + c.n.held + notDue,
    held: c.n.held,
    unaccounted: c.n.unaccounted,
  };
}

/** Needed vs capacity for a tier at a cadence, in the tier's unit. */
export function volumeAt(t: TierPayload, cadence: Cadence) {
  const cad = cadenceOf(cadence);
  const cap = t.capacity;
  const people = t.everyone.total;
  const perDay = cap.mailboxes * cap.perMailboxDay;
  const capDay = cap.capDay === null ? perDay : Math.min(perDay, cap.capDay);
  const perUnit = cap.unit === "weekday" ? 1 : WEEKDAYS_PER_MONTH;
  const capacity = capDay * perUnit;
  // Sends a day to reach everyone once per period.
  const neededDay = cadence === "daily" ? capDay : people / cad.weekdays;
  const needed = Math.ceil(neededDay * perUnit);
  const mailboxesNeeded = cap.perMailboxDay > 0 ? Math.ceil(neededDay / cap.perMailboxDay) : 0;
  const buildMore = Math.max(mailboxesNeeded - cap.mailboxes, 0);
  const capBinds = cap.capDay !== null && neededDay > cap.capDay && perDay > cap.capDay;
  // daily (capped): send at capacity; report how long a full pass takes.
  const cycleWeekdays = capDay > 0 ? Math.ceil(people / capDay) : Infinity;
  return {
    needed,
    capacity,
    short: cadence !== "daily" && needed > capacity,
    buildMore,
    mailboxesNeeded,
    capBinds,
    capDay,
    perDay,
    cycleWeekdays,
  };
}

// --- compute -----------------------------------------------------------------

function emptyN(): Record<Bucket, number> {
  return { fresh: 0, just_emailed: 0, dueable: 0, resting: 0, held: 0, unaccounted: 0 };
}
function newCat(key: string, label: string, tag: Tag): CategoryStat {
  return {
    key,
    label,
    tag,
    total: 0,
    n: emptyN(),
    dueAges: [],
    sample: { fresh: [], just_emailed: [], resting: [], held: [], unaccounted: [], dueOldest: [], dueNewest: [] },
    heldReasons: [],
  };
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
    routed: number; // everyone who landed in this tier, suppressed included
    suppressed: number;
    upNextReady: number;
    upNextReveal: number;
    dueAll: Person[]; // every dueable person, for the Everyone samples
    catDue: Map<string, Person[]>;
  };
  const mk = (tag: Tag): Acc => ({
    everyone: newCat("everyone", "Everyone", tag),
    cats: new Map(),
    routed: 0,
    suppressed: 0,
    upNextReady: 0,
    upNextReveal: 0,
    dueAll: [],
    catDue: new Map(),
  });
  const tiers: Record<TierKey, Acc> = { cold: mk("live"), warm: mk("derived"), offer: mk("derived") };
  // Seed cold categories so empty segments still show.
  for (const [k, l] of Object.entries(COLD_LABELS)) tiers.cold.cats.set(k, newCat(k, l, "live"));

  for (const p of data.prospects) {
    const email = lc(p.email);
    let tier: TierKey;
    if (p.engine === "cold") tier = "cold";
    else if (p.engine === "warm") {
      const recentBooker = p.ever_booked && (p.last_event_date ?? "") >= twelveMonthsAgoISO;
      tier = p.marketing_opt_in || recentBooker ? "offer" : "warm";
    } else continue; // no engine: manual contacts, outside every tier
    const acc = tiers[tier];
    acc.routed++;

    // Suppressed people leave the system before anything is counted.
    if (p.status === "suppressed" || p.status === "dead" || (email && suppressed.has(email))) {
      acc.suppressed++;
      continue;
    }

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

    // State
    const touchedMs = p.last_outreach_at ? Date.parse(p.last_outreach_at) : NaN;
    const ageDays = Number.isNaN(touchedMs) ? null : Math.floor((nowMs - touchedMs) / DAY);
    const domain = email.split("@")[1] ?? "";
    const warmEligible =
      tier !== "cold" &&
      p.status === "raw" &&
      !p.last_outreach_at &&
      !!email &&
      !["invalid", "disposable"].includes(p.verify_status ?? "") &&
      !talkedRecently.has(email) &&
      !blocked.has(domain);
    let bucket: Bucket;
    let why: string;
    if (p.status === "sequenced" && ageDays !== null && ageDays <= JUST_EMAILED_DAYS) {
      bucket = "just_emailed";
      why = `emailed ${ageDays}d ago`;
    } else if (tier === "cold" && ["raw", "enriched", "queued"].includes(p.status) && !p.last_outreach_at) {
      bucket = "fresh";
      why = p.email ? "never emailed, email ready" : "never emailed, needs Apollo email reveal";
      if (p.email) acc.upNextReady++;
      else acc.upNextReveal++;
    } else if (warmEligible) {
      bucket = "fresh";
      why = "never emailed";
    } else if (p.status === "replied" || p.status === "handed_off") {
      bucket = "resting";
      why = "replied / handed to sales";
    } else if (p.status === "sequenced" && p.last_outreach_at) {
      bucket = "dueable";
      why = "emailed";
    } else if (p.status === "called_lost") {
      bucket = "dueable";
      why = "called, lost";
    } else if (p.status === "raw" && p.last_outreach_at) {
      bucket = "dueable";
      why = "emailed, back to raw";
    } else if (tier !== "cold" && p.status === "raw" && !p.last_outreach_at && email && blocked.has(domain)) {
      bucket = "held";
      why = "held: blocked provider";
    } else if (tier !== "cold" && p.status === "raw" && !p.last_outreach_at && email && talkedRecently.has(email)) {
      bucket = "held";
      why = "held: talked since May";
    } else if (tier !== "cold" && p.status === "raw" && !p.last_outreach_at && ["invalid", "disposable"].includes(p.verify_status ?? "")) {
      bucket = "held";
      why = "held: bad email";
    } else {
      bucket = "unaccounted";
      why = `status=${p.status}${p.last_outreach_at ? ", emailed" : ", never emailed"}${email ? "" : ", no email"}`;
    }

    const person: Person = {
      id: p.id,
      name: p.name || p.company || "(no name)",
      email: p.email,
      status: p.status,
      last_touch: p.last_outreach_at,
      age_days: ageDays,
      why,
    };
    for (const c of [acc.everyone, cat]) {
      c.total++;
      c.n[bucket]++;
      if (bucket === "dueable") {
        c.dueAges.push(ageDays ?? 0);
      } else {
        c.sample[bucket].push(person);
      }
      if (bucket === "held") {
        const h = c.heldReasons.find((r) => r.why === why);
        if (h) h.n++;
        else c.heldReasons.push({ why, label: HELD_LABELS[why] ?? why, n: 1 });
      }
    }
    if (bucket === "dueable") {
      acc.dueAll.push(person);
      const list = acc.catDue.get(catKey) ?? [];
      list.push(person);
      acc.catDue.set(catKey, list);
    }
  }

  const finish = (c: CategoryStat, due: Person[]) => {
    for (const b of ["fresh", "just_emailed", "resting", "held", "unaccounted"] as const) {
      c.sample[b].sort((a, b2) => (b2.last_touch ?? "").localeCompare(a.last_touch ?? ""));
      c.sample[b] = c.sample[b].slice(0, SAMPLE_CAP);
    }
    c.dueAges.sort((a, b) => a - b);
    const byAge = [...due].sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0));
    c.sample.dueOldest = byAge.slice(0, SAMPLE_CAP);
    c.sample.dueNewest = byAge.slice(-SAMPLE_CAP).reverse();
    c.heldReasons.sort((a, b) => b.n - a.n);
    return c;
  };

  const warmMailboxes = data.mailboxes.filter((m) => !m.frozen);
  const warmPerMailbox = warmMailboxes[0]?.daily_allowance ?? 33;

  const meta: Record<TierKey, { label: string; blurb: string; definition: string }> = {
    cold: {
      label: "Cold",
      blurb: "Top of funnel",
      definition: "Apollo prospects who never contacted us.",
    },
    warm: {
      label: "Warm",
      blurb: "Middle of funnel",
      definition: "Enquired before, or booked more than 12 months ago and not opted in.",
    },
    offer: {
      label: "Offer",
      blurb: "Bottom of funnel",
      definition: "Booked in the last 12 months, or opted in to marketing.",
    },
  };

  const build = (key: TierKey): TierPayload => {
    const acc = tiers[key];
    const categories = Array.from(acc.cats.values())
      .map((c) => finish(c, acc.catDue.get(c.key) ?? []))
      .sort((a, b) => b.total - a.total);
    const everyone = finish(acc.everyone, acc.dueAll);
    if (key === "cold") {
      everyone.upNextSplit = [
        { label: "have an email", n: acc.upNextReady },
        { label: "need an Apollo email reveal", n: acc.upNextReveal },
      ];
      everyone.sources = [
        { label: "Apollo", n: everyone.total, tag: "derived" },
        { label: "LinkedIn", n: 0, tag: "mock" },
        { label: "Other lists", n: 0, tag: "mock" },
      ];
    }

    // Invariant: routed = everyone + suppressed; everyone = sum of its states;
    // everyone = sum of the categories. Anything else is "unaccounted".
    const catSum = categories.reduce((s, c) => s + c.total, 0);
    const stateSum = BUCKETS.filter((b) => b !== "unaccounted").reduce((s, b) => s + everyone.n[b], 0);
    const unaccounted =
      everyone.n.unaccounted +
      Math.abs(everyone.total - stateSum - everyone.n.unaccounted) +
      Math.abs(everyone.total - catSum) +
      Math.abs(acc.routed - acc.suppressed - everyone.total);

    let capacity: TierPayload["capacity"];
    if (key === "cold") {
      capacity = {
        unit: "weekday",
        mailboxes: COLD_MAILBOXES,
        perMailboxDay: COLD_PER_MAILBOX_DAY,
        capDay: null,
        tag: "static",
        source: `${COLD_MAILBOXES} Apollo mailboxes × ${COLD_PER_MAILBOX_DAY}/day (static). Cold Pilot A is inactive, so real sends today are 0.`,
      };
    } else if (key === "warm") {
      capacity = {
        unit: "month",
        mailboxes: warmMailboxes.length,
        perMailboxDay: warmPerMailbox,
        capDay: WARM_GLOBAL_CAP_DAY,
        tag: "live",
        source: `${warmMailboxes.length} news.* mailboxes × ${warmPerMailbox}/day (live), capped at ${WARM_GLOBAL_CAP_DAY}/day by OUTREACH_DAILY_CAP (static), × ${WEEKDAYS_PER_MONTH} weekdays.`,
      };
    } else {
      capacity = {
        unit: "month",
        mailboxes: 0,
        perMailboxDay: warmPerMailbox,
        capDay: null,
        tag: "mock",
        source: `No offer lane exists (mock: 0 mailboxes). A mailbox is assumed to carry ${warmPerMailbox}/day like the warm ones. Today warm_sender mails offer people the warm template.`,
      };
    }

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
              note: `${COLD_SEQUENCE.steps} step, ${COLD_SEQUENCE.contacts} contacts, ${COLD_SEQUENCE.active ? "active" : "inactive"} (Apollo, 2026-09-27).`,
            }
          : key === "warm"
            ? {
                name: "warm_sender template",
                steps: 1,
                url: WARM_TEMPLATE_URL,
                tag: "static",
                note: 'Single email, subject "Ice cream catering for holiday events". No follow-up step.',
              }
            : {
                name: "No offer sequence yet",
                steps: 0,
                url: null,
                tag: "mock",
                note: "Placeholder. Offers may go through Kit; nothing is wired.",
              },
      defaultCadence: DEFAULT_CADENCE[key],
      capacity,
      check: { suppressed: acc.suppressed, unaccounted, ok: unaccounted === 0 },
    };
  };

  return {
    generated_at: now.toISOString(),
    tiers: [build("cold"), build("warm"), build("offer")],
    totals: { prospects: data.prospects.length },
    notes: [
      "Tiers and warm/offer categories are worked out by this page; there are no tier or category columns yet (bj-finance #438).",
      "Cold categories are the Apollo segments stored on each prospect.",
      "People who opted out, bounced or are on the suppression list are left out of every number.",
      "The Offer tier is carved out of the warm list, so warm_sender treats offer people as warm today.",
    ],
  };
}
