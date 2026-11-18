// PROTOTYPE (bj-finance #811), throwaway. The sales lane numbers the console
// cannot work out from outreach_events: Apollo's cold sends, opens and
// replies, replies matched to sends, deals and bookings (new and repeat),
// spend and cost per new customer, mailbox health against each lane's daily
// target, offer deals, and the publisher's alerts. bj-finance builds them once
// a day and publishes one row into public.metrics_snapshots with kind
// 'sales_lanes' (crm-app migration 57 lets the table take that kind). The
// console reads the newest row as the signed-in manager (RLS: managers read).
//
// THE CONTRACT, schema 1:
//   schema 1 · as_of (ISO) · period (YYYY-MM-DD) · since (YYYY-MM-DD)
//   lanes     [{ lane, target_daily_sends, yesterday, last_7d, month_to_date, since_start }]
//             yesterday, last_7d: { sent, delivered, opened, opened_human, replied, deals, booked }
//             month_to_date, since_start: the same plus new_customers,
//             repeat_customers, revenue_pretax, spend, cac
//   mailboxes [{ address, lane, frozen, frozen_reason, frozen_since, daily_allowance,
//                ceiling, sent_yesterday, sent_7d_avg }]
//   offers    [{ offer, sent, opened, opened_human, clicked, replied, open_deal_ids, booked_deal_ids }]
//   alerts    [{ severity: "red" | "amber", text }]
//   sources   { <source>: "ok" | "error: ..." }
// Any number may be null: not measured. It reads "not measured", never 0. A
// payload that breaks the contract is refused whole ("cannot read these
// numbers"), never read as zeros.
//
// Badges are NOT decided here: attention.ts turns these into items.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LaneKey } from "./facts";
import { etDay } from "./time";

export const SALES_LANES_SCHEMA = 1;

export type Measure = number | null;

export type SalesCounts = {
  sent: Measure;
  delivered: Measure;
  opened: Measure;
  openedByPerson: Measure;
  replied: Measure;
  deals: Measure;
  booked: Measure;
};

export type SalesTotals = SalesCounts & {
  newCustomers: Measure;
  repeatCustomers: Measure;
  revenuePretax: Measure;
  spend: Measure;
  /** Cost per new customer, as the publisher worked it out. */
  costPerNew: Measure;
};

export type SalesLane = {
  lane: string;
  targetDailySends: Measure;
  yesterday: SalesCounts;
  last7d: SalesCounts;
  monthToDate: SalesTotals;
  sinceStart: SalesTotals;
};

export type SalesMailbox = {
  address: string;
  lane: string;
  frozen: boolean;
  frozenReason: string | null;
  frozenSince: string | null;
  dailyAllowance: Measure;
  ceiling: Measure;
  sentYesterday: Measure;
  sent7dAvg: Measure;
};

export type SalesOffer = {
  offer: string;
  sent: Measure;
  opened: Measure;
  openedByPerson: Measure;
  clicked: Measure;
  replied: Measure;
  openDealIds: number[];
  bookedDealIds: number[];
};

export type SalesAlert = { severity: "red" | "amber"; text: string };

export type SalesSnapshot = {
  asOf: string;
  period: string;
  since: string;
  lanes: SalesLane[];
  mailboxes: SalesMailbox[];
  offers: SalesOffer[];
  alerts: SalesAlert[];
  /** Each source the publisher could not read, and what it said. */
  sourceProblems: { source: string; detail: string }[];
};

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const isDay = (x: unknown): x is string => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);

class Refused extends Error {}

function measure(o: Obj, key: string): Measure {
  const v = o[key];
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new Refused(`${key} is not a number`);
}
function text(o: Obj, key: string): string | null {
  const v = o[key];
  if (v == null) return null;
  if (typeof v === "string") return v;
  throw new Refused(`${key} is not text`);
}
function obj(o: Obj, key: string): Obj {
  const v = o[key];
  if (v == null) return {};
  if (isObj(v)) return v;
  throw new Refused(`${key} is not an object`);
}
function list(o: Obj, key: string): unknown[] {
  const v = o[key];
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  throw new Refused(`${key} is not a list`);
}
function row(x: unknown, what: string): Obj {
  if (!isObj(x)) throw new Refused(`a ${what} is not an object`);
  return x;
}
function ids(o: Obj, key: string): number[] {
  return list(o, key).map((v) => {
    if (typeof v === "number" && Number.isInteger(v)) return v;
    throw new Refused(`${key} holds something that is not a deal id`);
  });
}
function counts(o: Obj): SalesCounts {
  return {
    sent: measure(o, "sent"),
    delivered: measure(o, "delivered"),
    opened: measure(o, "opened"),
    openedByPerson: measure(o, "opened_human"),
    replied: measure(o, "replied"),
    deals: measure(o, "deals"),
    booked: measure(o, "booked"),
  };
}
function totals(o: Obj): SalesTotals {
  return {
    ...counts(o),
    newCustomers: measure(o, "new_customers"),
    repeatCustomers: measure(o, "repeat_customers"),
    revenuePretax: measure(o, "revenue_pretax"),
    spend: measure(o, "spend"),
    costPerNew: measure(o, "cac"),
  };
}

/** The payload as the console reads it; null when it is not schema 1 or breaks the contract. */
export function parseSalesLanes(p: unknown): SalesSnapshot | null {
  if (!isObj(p) || p.schema !== SALES_LANES_SCHEMA) return null;
  try {
    const asOf = text(p, "as_of");
    if (!asOf || Number.isNaN(Date.parse(asOf)) || !isDay(p.period) || !isDay(p.since)) return null;
    const lanes = list(p, "lanes").map((x): SalesLane => {
      const l = row(x, "lane");
      const lane = text(l, "lane");
      if (!lane) throw new Refused("a lane has no name");
      return {
        lane,
        targetDailySends: measure(l, "target_daily_sends"),
        yesterday: counts(obj(l, "yesterday")),
        last7d: counts(obj(l, "last_7d")),
        monthToDate: totals(obj(l, "month_to_date")),
        sinceStart: totals(obj(l, "since_start")),
      };
    });
    const mailboxes = list(p, "mailboxes").map((x): SalesMailbox => {
      const m = row(x, "mailbox");
      const address = text(m, "address");
      if (!address) throw new Refused("a mailbox has no address");
      if (m.frozen != null && typeof m.frozen !== "boolean") throw new Refused("frozen is not true or false");
      return {
        address,
        lane: text(m, "lane") ?? "",
        frozen: m.frozen === true,
        frozenReason: text(m, "frozen_reason"),
        frozenSince: text(m, "frozen_since"),
        dailyAllowance: measure(m, "daily_allowance"),
        ceiling: measure(m, "ceiling"),
        sentYesterday: measure(m, "sent_yesterday"),
        sent7dAvg: measure(m, "sent_7d_avg"),
      };
    });
    const offers = list(p, "offers").map((x): SalesOffer => {
      const o = row(x, "offer");
      const offer = text(o, "offer");
      if (!offer) throw new Refused("an offer has no name");
      return {
        offer,
        sent: measure(o, "sent"),
        opened: measure(o, "opened"),
        openedByPerson: measure(o, "opened_human"),
        clicked: measure(o, "clicked"),
        replied: measure(o, "replied"),
        openDealIds: ids(o, "open_deal_ids"),
        bookedDealIds: ids(o, "booked_deal_ids"),
      };
    });
    const alerts = list(p, "alerts").map((x): SalesAlert => {
      const a = row(x, "alert");
      const t = text(a, "text");
      if ((a.severity !== "red" && a.severity !== "amber") || !t) throw new Refused("an alert is not red or amber with words");
      return { severity: a.severity, text: t };
    });
    const sourceProblems = Object.entries(obj(p, "sources"))
      .filter(([, v]) => v !== "ok")
      .map(([source, v]) => ({ source, detail: typeof v === "string" ? v.replace(/^error:\s*/, "") : "no answer" }));
    return { asOf, period: p.period, since: p.since, lanes, mailboxes, offers, alerts, sourceProblems };
  } catch (e) {
    if (e instanceof Refused) return null;
    throw e;
  }
}

// ---- the row as read, and what the console is given -------------------------------

export type SalesLanesRow = { period: string; built_at: string; payload: unknown };

export type SalesLanesInputs =
  | { status: "unreadable"; message: string }
  | { status: "read"; row: SalesLanesRow | null };

export type SalesLanesData =
  /** No row yet: the publisher has not run. Gray "No data", no badge. */
  | { status: "empty" }
  | { status: "unreadable"; message: string }
  | { status: "unrecognised"; builtAt: string }
  | {
      status: "ok";
      builtAt: string;
      /** Built before today (New York): said plainly, and the numbers still shown. */
      stale: boolean;
      snapshot: SalesSnapshot;
      synthetic?: string;
    };

/** The newest 'sales_lanes' snapshot, read as the signed-in manager. */
export async function loadSalesLanes(supabase: SupabaseClient): Promise<SalesLanesInputs> {
  try {
    const { data, error } = await supabase
      .from("metrics_snapshots")
      .select("period, built_at, payload")
      .eq("kind", "sales_lanes")
      .order("period", { ascending: false })
      .order("built_at", { ascending: false })
      .limit(1);
    if (error) return { status: "unreadable", message: error.message };
    return { status: "read", row: ((data ?? [])[0] as SalesLanesRow | undefined) ?? null };
  } catch (e) {
    return { status: "unreadable", message: e instanceof Error ? e.message : String(e) };
  }
}

export function buildSalesLanes(f: SalesLanesInputs, now: Date): SalesLanesData {
  if (f.status !== "read") return f;
  if (!f.row) return { status: "empty" };
  const snapshot = parseSalesLanes(f.row.payload);
  if (!snapshot) return { status: "unrecognised", builtAt: f.row.built_at };
  return { status: "ok", builtAt: f.row.built_at, stale: etDay(f.row.built_at) < etDay(now), snapshot };
}

// ---- lanes: the payload's names against the console's four ---------------------------

/** The payload lanes that are one of the console's email lanes. Holiday Gift is the Offer lane's email. */
const CONSOLE_LANE: Record<string, LaneKey> = { cold: "cold", warm: "warm", "warm: wedding": "wedding", "holiday gift": "offer" };

/** The other payload lanes, in plain words: they show in the sales numbers panel only. */
const CHANNEL_NAME: Record<string, string> = {
  "call desk": "Call desk",
  davianna: "Davianna (by hand)",
  "meta: instagram": "Instagram ads",
  "meta: facebook": "Facebook ads",
  unattributed: "No lane recorded",
};

export function consoleLaneOf(lane: string): LaneKey | null {
  return CONSOLE_LANE[lane] ?? null;
}

export function salesLaneName(lane: string): string {
  const c = CONSOLE_LANE[lane];
  if (c) return { cold: "Cold", warm: "Warm", wedding: "Wedding", offer: "Holiday Gift (Offer)" }[c];
  return CHANNEL_NAME[lane] ?? lane;
}

export function salesFor(d: SalesLanesData, lane: LaneKey): SalesLane | null {
  if (d.status !== "ok") return null;
  return d.snapshot.lanes.find((l) => CONSOLE_LANE[l.lane] === lane) ?? null;
}

export function salesMailbox(d: SalesLanesData, address: string): SalesMailbox | null {
  if (d.status !== "ok") return null;
  return d.snapshot.mailboxes.find((m) => m.address.toLowerCase() === address.toLowerCase()) ?? null;
}

/**
 * Which console lane an alert is about, from the lane it starts with ("Cold
 * sent 0 emails ..."); null when it names none (it then lives in the sales
 * numbers panel). The contract's alerts carry words only.
 */
export function alertLane(textIn: string): LaneKey | null {
  const t = textIn.trim().toLowerCase();
  const words: [string, LaneKey][] = [
    ["warm: wedding", "wedding"],
    ["wedding", "wedding"],
    ["holiday gift", "offer"],
    ["offer", "offer"],
    ["cold", "cold"],
    ["warm", "warm"],
  ];
  for (const [w, lane] of words) if (t.startsWith(w) && !/[a-z]/.test(t.charAt(w.length))) return lane;
  return null;
}

/** "holiday_gift_2026" as "Holiday Gift 2026". */
export function offerName(offer: string): string {
  return offer
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Emails a day over the last 7 days; null when not measured. */
export function perDay7(l: SalesLane): Measure {
  return l.last7d.sent == null ? null : Math.round((l.last7d.sent / 7) * 10) / 10;
}

// ---- local dev fixture --------------------------------------------------------------

/**
 * A SYNTHETIC sales_lanes payload for local dev and screenshots, in the shape
 * the publisher writes. Invented figures (crm-app is public), shaped like the
 * November 2026 picture: every cold mailbox stopped for hard bounces and the
 * cold lane at 0 against its 100 a day, warm sending, a Holiday Gift offer
 * with one open deal, paid Instagram winning new customers.
 */
export function salesLanesFixture(now: Date): unknown {
  const day = (n: number) => etDay(new Date(now.getTime() - n * 86_400_000));
  const zero = { sent: 0, delivered: 0, opened: 0, opened_human: 0, replied: 0, deals: 0, booked: 0 };
  const money = { new_customers: 0, repeat_customers: 0, revenue_pretax: 0, spend: null, cac: null };
  const lane = (l: string, target: number | null, y: object, w: object, mtd: object, all: object) => ({
    lane: l,
    target_daily_sends: target,
    yesterday: { ...zero, ...y },
    last_7d: { ...zero, ...w },
    month_to_date: { ...zero, ...money, ...mtd },
    since_start: { ...zero, ...money, ...all },
  });
  const notEmail = { sent: null, delivered: null, opened: null, opened_human: null, replied: null };
  return {
    schema: 1,
    as_of: now.toISOString(),
    period: day(1),
    since: "2026-08-01",
    lanes: [
      lane("cold", 100, {}, {}, { deals: 0 }, { sent: 400, delivered: 380, opened: 30, opened_human: 10, replied: 2, deals: 1, booked: 0 }),
      lane("warm", 25, { sent: 21, delivered: 21, opened: 9, opened_human: 6 }, { sent: 160, delivered: 158, opened: 61, opened_human: 40, replied: 5, deals: 2, booked: 1 },
        { sent: 300, delivered: 296, opened: 120, opened_human: 80, replied: 11, deals: 4, booked: 2, repeat_customers: 2, revenue_pretax: 1800 },
        { sent: 1200, delivered: 1180, opened: 470, opened_human: 300, replied: 45, deals: 9, booked: 5, repeat_customers: 5, revenue_pretax: 4100.5 }),
      lane("warm: wedding", 40, { sent: 9, delivered: 9 }, { sent: 57, delivered: 56, opened: 30, opened_human: 19, replied: 2, deals: 1 },
        { sent: 57, delivered: 56, opened: 30, opened_human: 19, replied: 2, deals: 1 }, { sent: 57, delivered: 56, opened: 30, opened_human: 19, replied: 2, deals: 1 }),
      lane("holiday gift", 20, { sent: 12, delivered: 12 }, { sent: 80, delivered: 79, opened: 44, opened_human: 15, replied: 2, deals: 1 },
        { sent: 100, delivered: 99, opened: 60, opened_human: 20, replied: 2, deals: 1 }, { sent: 100, delivered: 99, opened: 60, opened_human: 20, replied: 2, deals: 1 }),
      lane("call desk", null, { ...notEmail }, { ...notEmail, deals: 1 }, { ...notEmail, deals: 2, booked: 1, new_customers: 1, revenue_pretax: 950 }, { ...notEmail, deals: 6, booked: 3, new_customers: 2, repeat_customers: 1, revenue_pretax: 3300 }),
      lane("meta: instagram", null, { ...notEmail }, { ...notEmail }, { ...notEmail, deals: 2, booked: 2, new_customers: 2, revenue_pretax: 1400, spend: 500, cac: 250 }, { ...notEmail, deals: 3, booked: 2, new_customers: 2, revenue_pretax: 1400, spend: 500, cac: 250 }),
      lane("meta: facebook", null, { ...notEmail }, { ...notEmail }, { ...notEmail, deals: null, booked: null, spend: 0 }, { ...notEmail, deals: null, booked: null, spend: 0 }),
      lane("unattributed", null, { ...notEmail }, { ...notEmail, deals: 3 }, { ...notEmail, deals: 5, booked: 2, new_customers: 1, repeat_customers: 1, revenue_pretax: 2200 }, { ...notEmail, deals: 30, booked: 12, new_customers: 8, repeat_customers: 4, revenue_pretax: 15000 }),
    ],
    mailboxes: [
      ...["alana", "alina", "anastasia"].map((n, i) => ({
        address: `${n}@phillyicecreamcatering.com`, lane: "cold", frozen: true, frozen_reason: `hard bounces over 2% in 14 days (synthetic)`,
        frozen_since: day(22 + (i % 2)), daily_allowance: i === 1 ? 30 : 15, ceiling: null, sent_yesterday: 0, sent_7d_avg: 0,
      })),
      { address: "catering@benjerryphilly.com", lane: "warm", frozen: false, frozen_reason: null, frozen_since: null, daily_allowance: 3, ceiling: 3, sent_yesterday: 3, sent_7d_avg: 2.6 },
      ...["jacob", "jake", "jakob"].map((n) => ({
        address: `${n}@news.benjerryphilly.com`, lane: "warm", frozen: false, frozen_reason: null, frozen_since: null, daily_allowance: 7, ceiling: 33, sent_yesterday: 6, sent_7d_avg: 5.7,
      })),
    ],
    offers: [{ offer: "holiday_gift_2030", sent: 100, opened: 60, opened_human: 20, clicked: 5, replied: 2, open_deal_ids: [90001], booked_deal_ids: [] }],
    alerts: [{ severity: "red", text: "Cold sent 0 emails in the last 7 days; target is 100 a day" }],
    sources: { imap_alina: "ok", imap_alex: "ok", apollo: "ok", db: "ok" },
  };
}
