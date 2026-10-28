// Email campaigns tab: the model. One screen to see the whole email system
// (tiers, categories, sequences, capacity) and drill into the people in it.
//
// Pure functions only: rows in, payload out. Nothing here writes anywhere.
// There are no tier/segment columns yet (bj-finance #438), so every tier and
// warm/offer category below is DERIVED here from existing columns. Anything
// the database cannot tell us is a named constant.
//
// v2 (owner review 2026-09-27):
// - Suppressed / opted-out people are dropped BEFORE counting, so every number
//   on screen is simply "people in it". The accounting invariant is still
//   checked here (`TierPayload.check`); the UI shows nothing unless it breaks.
// - Volume is "reach everyone in the tier once per cadence"; the model ships
//   the capacity inputs and the client does the arithmetic per cadence.
//
// v3 (owner review of v2, 2026-09-27): three states only, defined by the
// tier's period (its "Reach everyone" cadence):
//   Up next = not emailed this period
//   Emailed = last emailed within the period
//   Held                = deliberately not sent to: Yahoo/Microsoft (blocked
//                         providers) until warm mailboxes are ready
// "Resting" is gone. People talked to since May are NOT held: they are Up next,
// sorted to the bottom of the list (lowest priority, still emailed). The period
// is picked in the UI, so the model ships the age (days since last email) of
// everyone who has been emailed and the client splits them per cadence.
//
// v5 (owner review of v4): never resend the same email.
//   Up next = still has a step of their sequence they have not had, and was
//             not emailed this period
//   Emailed = got a step this period and still has steps left
//   Held    = blocked provider, OR finished the sequence (nothing new to
//             send), OR no sequence yet, OR emailed but the send history
//             cannot say what they got ("moved tiers, no new step")
// "Already had step X" comes from the per-person send history
// (outreach_events 'sequenced' rows, detail->>'template'), read across every
// lane and every prospect row with the same email, so moving Offer -> Warm or
// CRM -> Warm never restarts a sequence. Sequences are edited in the browser,
// so the model ships people in GROUPS (same category, same history, same
// flags) and the client decides per group, with the current steps, which
// state it is in (statesAt).
//
// Personal cake (bj-finance #286, owner's rulings 2026-10-10): people who
// never booked, only ever asked us about a cake, and write from a consumer
// mailbox (Gmail, iCloud, an ISP...) are HELD out of the catering email by
// Catering-Manager outreach/migrations/012 (the HOLD clause on
// outreach_warm_eligible). A cake-only lead on a company domain is a catering
// prospect and is not held. Here the held get their own "Personal cake" card
// in Warm and Offer, in no other category, with no sequence of their own (it
// does not fall back to the tier's Everyone sequence), and they are left out
// of the Everyone card, Needed and capacity. isCakeOnly is that clause, line
// for line.
//
// Wedding leads (owners' rulings 2026-10-27): archived people (archived_at
// set) are dropped before counting, like suppressed people, with no archived
// count shown. In Warm and Offer a prospect whose own category is 'wedding' is
// in the wedding card even with no deal. A wedding contact whose event date
// (the prospect's event_date, else the category-setting deal's) is before
// today counts as archived, as the sender treats them.
//
// The wedding sequence (2026-10-27): Offer's Weddings & showers card has the
// wedding sender's three touches as its seed (sequences.ts), wired like Warm's
// warm_sender step, by the send-history templates each step counts. Touches 2
// and 3 have no copy yet. A step with no copy (empty subject and body) is an
// unwritten step: whoever had the steps before it is not finished, but it is
// sent to nobody, so it never makes anyone Up next (the sender's
// ready_touches() rule). Opens and clicks per template come from the
// 'opened'/'clicked' rows, joined to the send on its tracking id, as
// Catering-Manager's outreach_send_engagement view does (the view is not
// granted to the app). Two of the sender's facts hold for its own list (own
// category 'wedding'): it mails Yahoo/Microsoft addresses, so they are not
// held as blocked, and it dates the last email from the send history, so a
// logged send with no last_outreach_at stamped still counts as emailed then.

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
  // Why marketing_opt_in is true. 'booked' is the implied basis seeded for
  // past bookers and does NOT put anyone in Offer; only an explicit opt-in
  // does (EXPLICIT_OPT_IN_SOURCES).
  opt_in_source: string | null;
  last_outreach_at: string | null;
  verify_status: string | null;
  // The Salesforce lead status in `notes` is 'Cake Order' (leadStatusOf).
  // Filled by the loader; absent counts as false.
  cake_lead_status?: boolean;
  // The prospect's own event date (wedding imports), 'YYYY-MM-DD'.
  event_date?: string | null;
  // Set when the person is archived: out of every tier and every number.
  archived_at?: string | null;
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

/** One 'sequenced' outreach_events row: who got which template. A tracked
 * send carries the tracking id its open pixel and links report. */
export type SentRow = {
  prospect_id: number;
  template: string | null;
  tracking_id?: string | null;
  sent_at?: string | null; // occurred_at
};

/** One 'opened' or 'clicked' outreach_events row (docs/tracking.md). */
export type HitRow = { prospect_id: number; event: "opened" | "clicked"; tracking_id: string | null };

/** Tracked sends of one template, and how many were opened or clicked at
 * least once (outreach_engagement_by_template's opened_sends/clicked_sends). */
export type Engagement = { tracked: number; opened: number; clicked: number };

export type RawData = {
  prospects: ProspectRow[];
  deals: DealRow[];
  sent: SentRow[];
  hits?: HitRow[];
  suppressedEmails: string[];
  blockedDomains: string[];
  mailboxes: MailboxRow[];
};

export type TierKey = "cold" | "warm" | "offer";

export type Person = {
  id: number;
  name: string;
  email: string | null;
  status: string;
  last_touch: string | null;
  age_days: number | null; // whole days since last email; null = never emailed
  why: string; // the facts, e.g. "got warm_holiday_2026", "blocked provider"
};

/** People who behave the same for every sequence: same category, same send
 * history, same flags. The client puts a whole group in one state. */
export type Group = {
  cat: string; // category key
  received: string[]; // send-history keys (templates) they have had, sorted
  blocked: boolean; // Yahoo/Microsoft, until warm mailboxes are ready
  unknown: boolean; // emailed, but the history cannot say what they got
  talked: boolean; // talked to since May: bottom of Up next
  never: number; // never emailed on this prospect row
  needsReveal: number; // never emailed and no email yet (cold)
  ages: number[]; // days since last email of the emailed, ascending
  sample: { never: Person[]; oldest: Person[]; newest: Person[] };
};

export type CategoryStat = {
  key: string;
  label: string;
  total: number; // people in it; suppressed already excluded
  groups: Group[];
  sources?: { label: string; n: number }[];
  // A held category (Cake only): no sequence unless it gets its own, and left
  // out of the Everyone card, Needed and capacity.
  hold?: boolean;
  // Opens and clicks of the sends to the people in it, by template.
  engagement?: Record<string, Engagement>;
};

export type Sequence = {
  name: string;
  steps: number;
  url: string | null;
  note: string;
};

export type Cadence = "daily" | "weekly" | "biweekly" | "monthly" | "quarterly";

export type TierPayload = {
  key: TierKey;
  label: string;
  blurb: string;
  definition: string;
  total: number; // Everyone: people in the tier, suppressed excluded
  sources?: { label: string; n: number }[];
  categories: CategoryStat[];
  sequence: Sequence | null; // the tier's Everyone sequence (Offer: none)
  defaultCadence: Cadence;
  capacity: {
    unit: "weekday" | "month";
    mailboxes: number;
    perMailboxDay: number;
    capDay: number | null; // a global daily cap that binds before mailboxes
    source: string;
  };
  // Invariant, computed here, rendered only when broken.
  check: { suppressed: number; unaccounted: number; ok: boolean };
};

/** Tier connections (v5): how people move between tiers, counted where the
 * data says so. */
export type Flows = {
  coldReplied: number; // cold prospects who replied / were handed to sales
  coldToDeal: number; // cold prospects whose email is on a CRM deal
  coldSuppressed: number;
  offerBookedRecent: number; // in Offer because they booked in the last 12 months
  offerOptedIn: number; // in Offer because they explicitly opted in (and did not book recently)
  dealToWarm: number; // Warm: enquired (deal on file), never booked
  offerToWarm: number; // Warm: booked, but more than 12 months ago
  suppressed: number; // every tier: opted out / bounced / suppressed
};

export type Payload = {
  generated_at: string;
  tiers: TierPayload[];
  flows: Flows;
  totals: { prospects: number };
  notes: string[];
};

// --- static / assumed values ------------------------------------------------

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

const WEDDING = EVENT_BUCKETS.find((b) => b.key === "wedding")!;

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

/** Count of ascending `ages` that are < `max`. */
export function countBelow(ages: number[], max: number): number {
  return ages.length - countAtLeast(ages, max);
}

/** A step with no copy yet: part of the sequence, sent to nobody. */
export type UnwrittenStep = { keys: string[]; unwritten: true };
/** One step: the history keys that mean "already had it", or an unwritten
 * step with its keys. */
export type StepSpec = string[] | UnwrittenStep;
export const specKeys = (s: StepSpec): string[] => (Array.isArray(s) ? s : s.keys);
export const isUnwritten = (s: StepSpec): s is UnwrittenStep => !Array.isArray(s);

/** The steps that apply to a category, in order. Supplied by the client
 * (sequences are edited there). */
export type StepsFor = (catKey: string) => StepSpec[];

export type HeldReason = "blocked" | "finished" | "noSequence" | "moved" | "notWritten";
export const HELD_REASON_LABEL: Record<HeldReason, string> = {
  blocked: "blocked provider",
  finished: "finished sequence, nothing new to send",
  noSequence: "no sequence yet, nothing to send",
  moved: "moved tiers, no new step",
  notWritten: "next step's copy not written yet, nothing to send",
};
export const HELD_REASON_SHORT: Record<HeldReason, string> = {
  blocked: "blocked provider",
  finished: "finished sequence",
  noSequence: "no sequence yet",
  moved: "moved tiers, no new step",
  notWritten: "copy not written yet",
};

const hadStep = (g: Group, s: StepSpec) => specKeys(s).some((k) => g.received.includes(k));

/** Steps of `steps` this group has not had yet, written or not. */
export function unsentSteps(g: Group, steps: StepSpec[]): number {
  return steps.filter((s) => !hadStep(g, s)).length;
}

/** A group's standing, independent of the period: held (and why), open (its
 * next step can be sent), or waiting (its next step has no copy yet: emailed
 * this period, else held as notWritten; never Up next). */
export function groupStanding(g: Group, steps: StepSpec[]): HeldReason | "open" | "waiting" {
  if (g.blocked) return "blocked";
  if (g.unknown) return "moved";
  if (steps.length === 0) return "noSequence";
  const next = steps.find((s) => !hadStep(g, s));
  if (!next) return "finished";
  return isUnwritten(next) ? "waiting" : "open";
}

export const groupSize = (g: Group) => g.never + g.ages.length;

/** The owner's three states for one card at one cadence (period). */
export function statesAt(c: CategoryStat, cadence: Cadence, stepsFor: StepsFor) {
  const period = cadenceOf(cadence).periodDays;
  let upNext = 0;
  let emailed = 0;
  let lowPriority = 0;
  let upNextNeedsReveal = 0;
  let emailedWaiting = 0;
  const heldBy: Record<HeldReason, number> = { blocked: 0, finished: 0, noSequence: 0, moved: 0, notWritten: 0 };
  for (const g of c.groups) {
    const standing = groupStanding(g, stepsFor(g.cat));
    if (standing === "waiting") {
      const recent = countBelow(g.ages, period);
      emailed += recent;
      emailedWaiting += recent;
      heldBy.notWritten += groupSize(g) - recent;
      continue;
    }
    if (standing !== "open") {
      heldBy[standing] += groupSize(g);
      continue;
    }
    const due = g.never + countAtLeast(g.ages, period);
    upNext += due;
    emailed += countBelow(g.ages, period);
    if (g.talked) lowPriority += due;
    upNextNeedsReveal += g.needsReveal;
  }
  const held = heldBy.blocked + heldBy.finished + heldBy.noSequence + heldBy.moved + heldBy.notWritten;
  return {
    upNext,
    emailed,
    held,
    heldBy,
    // Talked to since May: part of Up next, listed last.
    lowPriority,
    upNextNeedsReveal,
    // Everyone who still has something to send (Needed counts these); not
    // those whose next step has no copy yet.
    withStepsLeft: upNext + emailed - emailedWaiting,
    // Invariant: every person is in exactly one state. Shown only if > 0.
    unaccounted: Math.abs(c.total - upNext - emailed - held),
  };
}

/** The Everyone card: every category's groups together, except held
 * categories (Cake only), which are not sent the tier's email. Needed and
 * capacity are worked out from this card, so they leave held people out too. */
export function everyoneOf(t: TierPayload): CategoryStat {
  const sendable = t.categories.filter((c) => !c.hold);
  const engagement: Record<string, Engagement> = {};
  for (const c of sendable)
    for (const [k, e] of Object.entries(c.engagement ?? {})) {
      const acc = (engagement[k] ??= { tracked: 0, opened: 0, clicked: 0 });
      acc.tracked += e.tracked;
      acc.opened += e.opened;
      acc.clicked += e.clicked;
    }
  return {
    key: "everyone",
    label: "Everyone",
    total: sendable.reduce((s, c) => s + c.total, 0),
    groups: sendable.flatMap((c) => c.groups),
    sources: t.sources,
    engagement,
  };
}

/** Opens and clicks of one step on one card: its templates' tracked sends
 * summed. Null when none of them was tracked (nothing to show). */
export function stepEngagement(c: CategoryStat, keys: string[]): Engagement | null {
  const out: Engagement = { tracked: 0, opened: 0, clicked: 0 };
  for (const k of keys) {
    const e = c.engagement?.[k];
    if (!e) continue;
    out.tracked += e.tracked;
    out.opened += e.opened;
    out.clicked += e.clicked;
  }
  return out.tracked > 0 ? out : null;
}

/** The steps that apply to a category: its own sequence if it has steps,
 * otherwise the tier's Everyone sequence. A held category never falls back to
 * Everyone, so with no sequence of its own it has nothing to send. */
export function categorySteps(catKey: string, own: StepSpec[], everyone: StepSpec[]): StepSpec[] {
  if (own.length) return own;
  return HOLD_CATEGORIES.has(catKey) ? [] : everyone;
}

/** Needed vs capacity for a tier at a cadence, in the tier's unit. Needed
 * counts only people who still have a step to send, once per cadence. */
export function volumeAt(t: TierPayload, cadence: Cadence, withStepsLeft: number) {
  const cad = cadenceOf(cadence);
  const cap = t.capacity;
  const people = withStepsLeft;
  const perDay = cap.mailboxes * cap.perMailboxDay;
  const capDay = cap.capDay === null ? perDay : Math.min(perDay, cap.capDay);
  const perUnit = cap.unit === "weekday" ? 1 : WEEKDAYS_PER_MONTH;
  const capacity = capDay * perUnit;
  // Sends a day to reach everyone once per period.
  const neededDay = cadence === "daily" ? Math.min(capDay, people) : people / cad.weekdays;
  const needed = Math.ceil(neededDay * perUnit);
  const mailboxesNeeded = cap.perMailboxDay > 0 ? Math.ceil(neededDay / cap.perMailboxDay) : 0;
  const buildMore = Math.max(mailboxesNeeded - cap.mailboxes, 0);
  const capBinds = cap.capDay !== null && neededDay > cap.capDay && perDay > cap.capDay;
  // daily (capped): send at capacity; report how long a full pass takes.
  const cycleWeekdays = capDay > 0 ? Math.ceil(people / capDay) : Infinity;
  return {
    people,
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

type GroupAcc = { group: Group; people: Person[] };
type CatAcc = { stat: CategoryStat; groups: Map<string, GroupAcc> };

function newCat(key: string, label: string): CatAcc {
  return { stat: { key, label, total: 0, groups: [] }, groups: new Map() };
}

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Opt-in sources that put a prospect in the Offer tier (bj-finance #425,
 * owners' ruling). Matches Catering-Manager outreach/migrations/009, which
 * excludes exactly these from outreach_warm_eligible. The 'booked' basis
 * seeded for past bookers is implied consent, not an opt-in to offers. */
export const EXPLICIT_OPT_IN_SOURCES: ReadonlySet<string> = new Set(["explicit_yes", "signup_form"]);

// --- cake only (bj-finance #286) ---------------------------------------------

// The key stays "cake_only" so sequences saved against it keep working; the
// card is labelled for who is in it since 012 (personal mailboxes only).
export const CAKE_ONLY = { key: "cake_only", label: "Personal cake" } as const;
/** Categories held out of the tier's email. Seeded on Warm and Offer so the
 * card shows even when nobody is in it. */
export const HOLD_CATEGORIES: ReadonlySet<string> = new Set([CAKE_ONLY.key]);

/** The Salesforce lead status: the first `;` field of the first line of
 * `notes`, where the master-base load (bj-finance #280) wrote
 * `lead_status; lead_source`. SQL: split_part(split_part(notes, E'\n', 1), ';', 1). */
export function leadStatusOf(notes: string | null | undefined): string {
  return (notes ?? "").split("\n")[0].split(";")[0];
}

/** lower(btrim(x)): Postgres btrim strips spaces only. null stays null. */
const sqlEmailKey = (s: string | null | undefined): string | null =>
  s === null || s === undefined ? null : s.replace(/^ +| +$/g, "").toLowerCase();

const NO_EVENT_TYPE: ReadonlySet<string> = new Set(["", "Cake Order", "--Pick One--"]);

/** Consumer mailbox providers: Catering-Manager outreach/consumer_domains.py,
 * copied into migration 012's HOLD clause and here. Exact match on the domain;
 * comcast.net is consumer, comcast.com (the employer) is not; .edu and .gov
 * are organisations. tests/emailCampaignsCakeOnlyParity.test.ts fails if this
 * set and the live view's ARRAY differ. */
export const CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
  "126.com", "163.com", "aim.com", "aol.com", "att.net", "bellsouth.net", "btinternet.com",
  "centurylink.net", "charter.net", "comcast.net", "cox.net", "currently.com", "duck.com",
  "earthlink.net", "fastmail.com", "foxmail.com", "gmail.com", "gmx.com", "gmx.de", "gmx.us",
  "googlemail.com", "hey.com", "hotmail.co.uk", "hotmail.com", "hotmail.fr", "icloud.com",
  "juno.com", "live.ca", "live.cn", "live.co.uk", "live.com", "mac.com", "mail.com", "mail.ru",
  "me.com", "mindspring.com", "msn.com", "naver.com", "netscape.net", "netzero.net",
  "optonline.net", "outlook.com", "passport.com", "pipeline.com", "pm.me", "proton.me",
  "protonmail.com", "ptd.net", "qq.com", "rcn.com", "rocketmail.com", "rr.com", "sbcglobal.net",
  "sina.com", "tutanota.com", "twcny.rr.com", "verizon.net", "web.de", "windstream.net",
  "yahoo.ca", "yahoo.co.in", "yahoo.co.uk", "yahoo.com", "yahoo.com.au", "yahoo.com.hk",
  "yahoo.de", "yahoo.es", "yahoo.fr", "yahoo.it", "yandex.com", "yandex.ru", "ymail.com",
  "zohomail.com",
]);

/** lower(split_part(btrim(email), '@', 2)) is a consumer mailbox provider. */
export function isConsumerDomain(email: string | null | undefined): boolean {
  const key = sqlEmailKey(email);
  return key !== null && CONSUMER_DOMAINS.has(key.split("@")[1] ?? "");
}

export type CakeEvidence = { cake: boolean; catering: boolean };

/** What each address has enquired about, from its CRM deals: the `dk`
 * subquery of migration 011. cake = a deal whose event type is exactly
 * 'Cake Order'; catering = a deal of any other type. A blank type or the
 * form's '--Pick One--' placeholder counts neither way. */
export function cakeEvidenceByEmail(deals: Pick<DealRow, "contact_email" | "event_type">[]): Map<string, CakeEvidence> {
  const out = new Map<string, CakeEvidence>();
  for (const d of deals) {
    const e = sqlEmailKey(d.contact_email);
    if (e === null) continue;
    const ev = out.get(e) ?? { cake: false, catering: false };
    if (d.event_type === "Cake Order") ev.cake = true;
    if (!NO_EVENT_TYPE.has((d.event_type ?? "").replace(/^ +| +$/g, ""))) ev.catering = true;
    out.set(e, ev);
  }
  return out;
}

/** Personal cake: never booked, cake evidence (lead status Cake Order, or a
 * Cake Order deal), no deal of any other type, and a consumer mailbox domain.
 * The HOLD (#286) clause of Catering-Manager
 * outreach/migrations/012_cake_hold_personal_only.sql; a cake-only lead on a
 * company, school or government domain is a catering prospect (owner's ruling
 * 2026-10-10). tests/emailCampaignsCakeOnly*.test.ts hold the two together. */
export function isCakeOnly(
  p: Pick<ProspectRow, "email" | "ever_booked" | "cake_lead_status">,
  evidence: Map<string, CakeEvidence>,
): boolean {
  if (p.ever_booked) return false;
  const key = sqlEmailKey(p.email);
  const ev = key === null ? undefined : evidence.get(key);
  return (!!p.cake_lead_status || !!ev?.cake) && !ev?.catering && isConsumerDomain(p.email);
}

export const isExplicitOptIn = (p: Pick<ProspectRow, "marketing_opt_in" | "opt_in_source">) =>
  p.marketing_opt_in && !!p.opt_in_source && EXPLICIT_OPT_IN_SOURCES.has(p.opt_in_source);

export function compute(data: RawData, now: Date): Payload {
  const nowMs = now.getTime();
  const DAY = 86_400_000;
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
  const twelveMonthsAgoISO = twelveMonthsAgo.toISOString().slice(0, 10);
  const todayISO = now.toISOString().slice(0, 10);

  const suppressed = new Set(data.suppressedEmails.map(lc));
  const blocked = new Set(data.blockedDomains.map(lc));

  // Send history, per prospect row, then shared by every row with that email
  // (a person can have a cold row and a warm row).
  const histById = new Map<number, Set<string>>();
  const lastSentById = new Map<number, string>();
  for (const r of data.sent ?? []) {
    if (!r.template) continue;
    if (r.sent_at && r.sent_at > (lastSentById.get(r.prospect_id) ?? "")) lastSentById.set(r.prospect_id, r.sent_at);
    let h = histById.get(r.prospect_id);
    if (!h) histById.set(r.prospect_id, (h = new Set()));
    h.add(r.template);
  }
  // Tracked sends per prospect row, and which of them were opened / clicked.
  const trackedById = new Map<number, { template: string; tid: string }[]>();
  for (const r of data.sent ?? []) {
    if (!r.template || !r.tracking_id) continue;
    let t = trackedById.get(r.prospect_id);
    if (!t) trackedById.set(r.prospect_id, (t = []));
    t.push({ template: r.template, tid: r.tracking_id });
  }
  const hitKeys = { opened: new Set<string>(), clicked: new Set<string>() };
  for (const h of data.hits ?? []) if (h.tracking_id) hitKeys[h.event]?.add(`${h.prospect_id}:${h.tracking_id}`);

  const histByEmail = new Map<string, Set<string>>();
  for (const p of data.prospects) {
    const h = histById.get(p.id);
    const e = lc(p.email);
    if (!h || !e) continue;
    const s = histByEmail.get(e) ?? new Set<string>();
    h.forEach((k) => s.add(k));
    histByEmail.set(e, s);
  }

  const cakeEvidence = cakeEvidenceByEmail(data.deals);

  // outreach_talked_recently, replicated (the view is not granted to the app).
  const talkedRecently = new Set<string>();
  const dealEmails = new Set<string>();
  const latestDeal = new Map<string, DealRow>();
  const latestBooked = new Map<string, DealRow>();
  for (const d of data.deals) {
    const e = lc(d.contact_email);
    if (!e) continue;
    dealEmails.add(e);
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

  type TierAcc = {
    total: number;
    needsReveal: number;
    cats: Map<string, CatAcc>;
    routed: number; // everyone who landed in this tier, suppressed and archived included
    suppressed: number;
    archived: number; // for the invariant only; never shown (owners, 2026-10-27)
  };
  const mk = (): TierAcc => ({ total: 0, needsReveal: 0, cats: new Map(), routed: 0, suppressed: 0, archived: 0 });
  const tiers: Record<TierKey, TierAcc> = { cold: mk(), warm: mk(), offer: mk() };
  // Seed cold categories so empty segments still show.
  for (const [k, l] of Object.entries(COLD_LABELS)) tiers.cold.cats.set(k, newCat(k, l));
  // Cake only is held, so its card shows on Warm and Offer even when empty.
  for (const t of ["warm", "offer"] as const) {
    const c = newCat(CAKE_ONLY.key, CAKE_ONLY.label);
    c.stat.hold = true;
    tiers[t].cats.set(CAKE_ONLY.key, c);
  }

  const flows: Flows = {
    coldReplied: 0,
    coldToDeal: 0,
    coldSuppressed: 0,
    offerBookedRecent: 0,
    offerOptedIn: 0,
    dealToWarm: 0,
    offerToWarm: 0,
    suppressed: 0,
  };

  for (const p of data.prospects) {
    const email = lc(p.email);
    let tier: TierKey;
    let recentBooker = false;
    if (p.engine === "cold") tier = "cold";
    else if (p.engine === "warm") {
      recentBooker = p.ever_booked && (p.last_event_date ?? "") >= twelveMonthsAgoISO;
      // Offer = booked in the last 12 months OR an explicit opt-in.
      tier = recentBooker || isExplicitOptIn(p) ? "offer" : "warm";
    } else continue; // no engine: manual contacts, outside every tier
    const acc = tiers[tier];
    acc.routed++;

    if (tier === "cold") {
      if (["replied", "handed_off", "interested"].includes(p.status)) flows.coldReplied++;
      if (email && dealEmails.has(email)) flows.coldToDeal++;
    }

    // Category. Warm/Offer flows are counted once the person is known to be in.
    let catKey: string;
    let catLabel: string;
    // The deal the tier reads the event type from (none for cold).
    const catDeal =
      tier === "warm" ? latestDeal.get(email) : tier === "offer" ? (latestBooked.get(email) ?? latestDeal.get(email)) : undefined;
    if (tier === "cold") {
      catKey = p.category ?? "uncategorised";
      catLabel = COLD_LABELS[catKey] ?? "Uncategorised";
    } else if (lc(p.category) === WEDDING.key) {
      // Their own category: Weddings & showers even with no deal (2026-10-27).
      catKey = WEDDING.key;
      catLabel = tier === "warm" ? `Enquired: ${WEDDING.label}` : WEDDING.label;
    } else if (tier === "warm") {
      if (p.ever_booked) {
        catKey = "past_booker";
        catLabel = "Past bookers (12 mo+)";
      } else if (!catDeal) {
        catKey = "no_deal";
        catLabel = "Salesforce lead, no deal on file";
      } else {
        const b = eventBucket(catDeal.event_type);
        catKey = b.key;
        catLabel = `Enquired: ${b.label}`;
      }
    } else {
      const b = eventBucket(catDeal?.event_type);
      catKey = b.key;
      catLabel = b.label;
    }
    // Cake only takes them out of every other warm/offer category (#286).
    if (tier !== "cold" && isCakeOnly(p, cakeEvidence)) {
      catKey = CAKE_ONLY.key;
      catLabel = CAKE_ONLY.label;
    }

    // Suppressed people leave the system before anything is counted.
    if (p.status === "suppressed" || p.status === "dead" || (email && suppressed.has(email))) {
      acc.suppressed++;
      continue;
    }
    // So do archived people, and wedding contacts whose date has passed (the
    // sender's rule), whether or not archived_at is stamped yet.
    const eventDate = (catKey === WEDDING.key && (p.event_date ?? catDeal?.event_date)) || "";
    if (p.archived_at || (/^\d{4}-\d{2}-\d{2}/.test(eventDate) && eventDate.slice(0, 10) < todayISO)) {
      acc.archived++;
      continue;
    }
    acc.total++;

    if (tier === "warm") {
      if (p.ever_booked) flows.offerToWarm++;
      else if (catDeal) flows.dealToWarm++;
    } else if (tier === "offer") {
      if (recentBooker) flows.offerBookedRecent++;
      else flows.offerOptedIn++;
    }

    let cat = acc.cats.get(catKey);
    if (!cat) {
      cat = newCat(catKey, catLabel);
      acc.cats.set(catKey, cat);
    }

    // Group inputs. The period split and the sequence check happen in
    // statesAt (cadence and sequences are client state).
    // The wedding sender's own list (outreach_wedding_schedule: engine warm,
    // category wedding).
    const onWeddingSender = lc(p.category) === WEDDING.key;
    const lastTouch = p.last_outreach_at ?? (onWeddingSender ? (lastSentById.get(p.id) ?? null) : null);
    const touchedMs = lastTouch ? Date.parse(lastTouch) : NaN;
    const ageDays = Number.isNaN(touchedMs) ? null : Math.max(0, Math.floor((nowMs - touchedMs) / DAY));
    const domain = email.split("@")[1] ?? "";
    const isBlocked = tier !== "cold" && !onWeddingSender && !!email && blocked.has(domain);
    const talked = tier !== "cold" && !!email && !isBlocked && talkedRecently.has(email);
    const hist = new Set<string>([...(histById.get(p.id) ?? []), ...((email && histByEmail.get(email)) || [])]);
    const received = Array.from(hist).sort();
    // Emailed, yet no send in the history says what: cannot tell which step
    // they had, so nothing is sent to them (owner's rule, v5).
    const unknown = ageDays !== null && received.length === 0;

    const facts: string[] = [];
    if (isBlocked) facts.push("Yahoo/Microsoft address");
    if (received.length) facts.push(`got ${received.join(", ")}`);
    else if (ageDays !== null) facts.push("emailed, send not in history");
    else if (tier === "cold") facts.push(p.email ? "never emailed, email ready" : "never emailed, needs Apollo email reveal");
    else if (["invalid", "disposable"].includes(p.verify_status ?? "")) facts.push("never emailed, email failed verification");
    else facts.push("never emailed");
    if (talked) facts.push("talked to since May: lowest priority");
    if (p.status === "replied" || p.status === "handed_off") facts.push("replied / handed to sales");
    else if (p.status === "called_lost") facts.push("called, lost");

    const person: Person = {
      id: p.id,
      name: p.name || p.company || "(no name)",
      email: p.email,
      status: p.status,
      last_touch: lastTouch,
      age_days: ageDays,
      why: facts.join(" · "),
    };

    const gKey = `${received.join("|")}/${+isBlocked}${+unknown}${+talked}`;
    let g = cat.groups.get(gKey);
    if (!g) {
      g = {
        group: {
          cat: catKey,
          received,
          blocked: isBlocked,
          unknown,
          talked,
          never: 0,
          needsReveal: 0,
          ages: [],
          sample: { never: [], oldest: [], newest: [] },
        },
        people: [],
      };
      cat.groups.set(gKey, g);
    }
    cat.stat.total++;
    g.people.push(person);
    for (const s of trackedById.get(p.id) ?? []) {
      const eng = (cat.stat.engagement ??= {});
      const e = (eng[s.template] ??= { tracked: 0, opened: 0, clicked: 0 });
      e.tracked++;
      if (hitKeys.opened.has(`${p.id}:${s.tid}`)) e.opened++;
      if (hitKeys.clicked.has(`${p.id}:${s.tid}`)) e.clicked++;
    }
    if (ageDays === null) {
      g.group.never++;
      if (!p.email) {
        g.group.needsReveal++;
        acc.needsReveal++;
      }
    } else g.group.ages.push(ageDays);
  }

  const asc = (a: number, b: number) => a - b;
  const finish = (c: CatAcc): CategoryStat => {
    c.stat.groups = Array.from(c.groups.values()).map(({ group, people }) => {
      group.ages.sort(asc);
      const emailed = people.filter((p) => p.age_days !== null);
      group.sample = {
        never: people.filter((p) => p.age_days === null).slice(0, SAMPLE_CAP),
        oldest: [...emailed].sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0)).slice(0, SAMPLE_CAP),
        newest: [...emailed].sort((a, b) => (a.age_days ?? 0) - (b.age_days ?? 0)).slice(0, SAMPLE_CAP),
      };
      return group;
    });
    return c.stat;
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
      definition: "Enquired before, or booked more than 12 months ago and not explicitly opted in.",
    },
    offer: {
      label: "Offer",
      blurb: "Bottom of funnel",
      definition: "Booked in the last 12 months, or explicitly opted in to offers.",
    },
  };

  const build = (key: TierKey): TierPayload => {
    const acc = tiers[key];
    const categories = Array.from(acc.cats.values())
      .map(finish)
      // Largest first; held categories last, after everything that is sent.
      .sort((a, b) => +!!a.hold - +!!b.hold || b.total - a.total);
    // Only Apollo feeds the cold tier today; LinkedIn and other lists have no
    // import path yet, so they are not listed.
    const sources: TierPayload["sources"] =
      key === "cold" ? [{ label: "Apollo", n: acc.total }] : undefined;

    // Invariant: routed = everyone + suppressed + archived; everyone = sum of the
    // categories = sum of the groups; and (checked per card, cadence and
    // sequence in statesAt) everyone = Up next + Emailed + Held.
    const catSum = categories.reduce((s, c) => s + c.total, 0);
    const groupSum = categories.reduce((s, c) => s + c.groups.reduce((t, g) => t + groupSize(g), 0), 0);
    const unaccounted =
      Math.abs(acc.total - groupSum) + Math.abs(acc.total - catSum) + Math.abs(acc.routed - acc.suppressed - acc.archived - acc.total);

    let capacity: TierPayload["capacity"];
    if (key === "cold") {
      capacity = {
        unit: "weekday",
        mailboxes: COLD_MAILBOXES,
        perMailboxDay: COLD_PER_MAILBOX_DAY,
        capDay: null,
        source: `${COLD_MAILBOXES} Apollo mailboxes × ${COLD_PER_MAILBOX_DAY}/day, from Apollo's mailbox settings (entered by hand, not read live). Cold Pilot A was inactive when last checked on 2026-09-27, with no cold sends.`,
      };
    } else if (key === "warm") {
      capacity = {
        unit: "month",
        mailboxes: warmMailboxes.length,
        perMailboxDay: warmPerMailbox,
        capDay: WARM_GLOBAL_CAP_DAY,
        source: `${warmMailboxes.length} news.* mailboxes × ${warmPerMailbox}/day (read live), capped at ${WARM_GLOBAL_CAP_DAY}/day by OUTREACH_DAILY_CAP (the warm sender's default; its live setting can't be read from here), × ${WEEKDAYS_PER_MONTH} weekdays.`,
      };
    } else {
      capacity = {
        unit: "month",
        mailboxes: 0,
        perMailboxDay: warmPerMailbox,
        capDay: null,
        source: `No offer lane yet, so 0 mailboxes. A mailbox is assumed to carry ${warmPerMailbox}/day like the warm ones. Wedding contacts in Offer are sent through the warm lane.`,
      };
    }

    return {
      key,
      ...meta[key],
      total: acc.total,
      sources,
      categories,
      sequence:
        key === "cold"
          ? {
              name: COLD_SEQUENCE.name,
              steps: COLD_SEQUENCE.steps,
              url: COLD_SEQUENCE.url,
              note: `${COLD_SEQUENCE.steps} step, ${COLD_SEQUENCE.contacts} contacts, ${COLD_SEQUENCE.active ? "active" : "inactive"} (last checked in Apollo on 2026-09-27).`,
            }
          : key === "warm"
            ? {
                name: "warm_sender template",
                steps: 1,
                url: null,
                note: 'Single email, subject "Ice cream catering for holiday events", logged as template warm_holiday_2026. No follow-up step.',
              }
            : null,
      defaultCadence: DEFAULT_CADENCE[key],
      capacity,
      check: { suppressed: acc.suppressed, unaccounted, ok: unaccounted === 0 },
    };
  };

  flows.coldSuppressed = tiers.cold.suppressed;
  const built = [build("cold"), build("warm"), build("offer")];
  flows.suppressed = built.reduce((s, t) => s + t.check.suppressed, 0);

  return {
    generated_at: now.toISOString(),
    tiers: built,
    flows,
    totals: { prospects: data.prospects.length },
    notes: [
      "Tiers and warm/offer categories are worked out by this page from existing columns; there are no tier or category columns yet.",
      "Cold categories are the Apollo segments stored on each prospect.",
      "People who opted out, bounced, are on the suppression list or are archived (wedding contacts past their date) are left out of every number.",
      "The Offer tier is carved out of the warm list; only its wedding contacts are sent, through the warm lane.",
      "Who got which email comes from the send history, across every tier and every contact record with the same email. Nobody is sent an email they already had.",
      "Offer › Weddings & showers shows the wedding sender's sequence (Catering-Manager outreach/wedding_copy.py): step 1 is V2, filled in per couple with the expo, the wedding date and a season paragraph; steps 2 and 3 have no copy yet, so nobody is sent them and nobody is Up next for them. Opens and clicks count tracked sends opened or clicked at least once.",
      "Personal cake (Warm and Offer): never booked, only ever asked us about a cake (Salesforce lead status Cake Order or a Cake Order deal, and no deal of any other type), and on a personal mailbox such as Gmail or iCloud; a cake-only contact on a company, school or government domain is a catering prospect instead. They are held out of the catering email (bj-finance #286), are in no other category, have no sequence of their own, and are not counted in Everyone, Needed or capacity.",
    ],
  };
}
