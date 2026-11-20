// The finance feed (bj-finance #671, ruling M2): what bj-finance
// modules/metrics_publish.py publishes into public.metrics_snapshots
// (migration 40), parsed, and the metrics the page builds on it.
//
// THE CONTRACT, schema 1 (the publisher's docstring carries the same):
//
//   kind 'daily', period = as_of (the business day the numbers run through)
//     cash            null | { as_of, bank_balance, outstanding_cheques, on_hand, day_in, day_out }
//     sales_by_day    [{ date, in_store, delivery, concessions, concessions_gross?, basis }]
//                     net sales before tax, no catering (the page counts catering
//                     by event date from the CRM); every day, no gaps.
//                     concessions is NET (Aramark's settlement) or null while
//                     the feed has no source for it; concessions_gross is
//                     register gross when known.
//     wages_by_week   [{ week_start (Monday), wages, employer_tax, salaried_wages }]
//                     complete weeks; wages include the salaried GM, not the owners.
//     cogs_pct_trailing  null | 0..1, actual COGS % over the last 3 closed months
//     forward_cash    null | { start, days, opening_on_hand, lines: [{ date, direction, category, amount, label }] }
//                     the next 14 days ex-catering (the page adds catering).
//
//   kind 'closed_month', period = the 1st of the month
//     month, status, revenue, revenue_by_stream { in_store, delivery, catering,
//     concessions, concessions_gross?, other }, cogs, gross_profit, wages,
//     employer_tax, pre_tax_profit, rolling_12 null | { months, revenue,
//     pre_tax_profit, seller_months }
//
// A payload that does not match is refused (null) and the page says "feed
// format not recognised"; it is never read as zeros.

import { addDays, monthStart } from "./dates.ts";
import { lerBoth } from "./ler.ts";
import type { LaborTargetWeek } from "./laborTarget.ts";
import type { SalesTargetRow } from "./targets.ts";
import type { StreamDaily } from "./series.ts";

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const day = (x: unknown): string | null => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);

export type FeedCash = { as_of: string; bank_balance: number; outstanding_cheques: number; on_hand: number; day_in: number; day_out: number };
export type FeedSalesDay = { date: string; in_store: number; delivery: number; concessions: number | null; concessions_gross: number | null; basis: string };
export type FeedWagesWeek = { week_start: string; wages: number; employer_tax: number; salaried_wages: number };
export type FeedForwardLine = { date: string; direction: "in" | "out"; category: string; amount: number; label: string };
export type FeedForward = { start: string; days: number; opening_on_hand: number; lines: FeedForwardLine[] };

export type DailySnapshot = {
  as_of: string;
  cash: FeedCash | null;
  sales_by_day: FeedSalesDay[];
  wages_by_week: FeedWagesWeek[];
  cogs_pct_trailing: number | null;
  cogs_basis: string | null;
  forward_cash: FeedForward | null;
};

export function parseCash(c: unknown): FeedCash | null {
  if (!isObj(c)) return null;
  const as_of = day(c.as_of);
  const fields = ["bank_balance", "outstanding_cheques", "on_hand", "day_in", "day_out"].map((k) => num(c[k]));
  if (!as_of || fields.some((f) => f == null)) return null;
  const [bank_balance, outstanding_cheques, on_hand, day_in, day_out] = fields as number[];
  return { as_of, bank_balance, outstanding_cheques, on_hand, day_in, day_out };
}

export function parseDaily(p: unknown): DailySnapshot | null {
  if (!isObj(p) || p.schema !== 1) return null;
  const as_of = day(p.as_of);
  if (!as_of || !Array.isArray(p.sales_by_day) || (p.wages_by_week != null && !Array.isArray(p.wages_by_week))) return null;
  const sales: FeedSalesDay[] = [];
  for (const r of p.sales_by_day) {
    if (!isObj(r)) return null;
    const date = day(r.date);
    const in_store = num(r.in_store);
    const delivery = num(r.delivery) ?? 0;
    // null = the feed has no source for concessions yet (Aramark settles in QBO only).
    const concessions = num(r.concessions);
    if (!date || in_store == null) return null;
    sales.push({ date, in_store, delivery, concessions, concessions_gross: num(r.concessions_gross), basis: String(r.basis ?? "booked") });
  }
  const wages: FeedWagesWeek[] = [];
  for (const r of (p.wages_by_week as unknown[] | null) ?? []) {
    if (!isObj(r)) return null;
    const week_start = day(r.week_start);
    const w = num(r.wages);
    const t = num(r.employer_tax);
    if (!week_start || w == null || t == null) return null;
    wages.push({ week_start, wages: w, employer_tax: t, salaried_wages: num(r.salaried_wages) ?? 0 });
  }
  let forward: FeedForward | null = null;
  if (isObj(p.forward_cash)) {
    const f = p.forward_cash;
    const lines: FeedForwardLine[] = [];
    for (const l of Array.isArray(f.lines) ? f.lines : []) {
      if (!isObj(l)) continue;
      const date = day(l.date);
      const amount = num(l.amount);
      if (!date || amount == null || (l.direction !== "in" && l.direction !== "out")) continue;
      lines.push({ date, direction: l.direction, category: String(l.category ?? "other"), amount, label: String(l.label ?? "") });
    }
    const start = day(f.start);
    const opening = num(f.opening_on_hand);
    forward = start && opening != null ? { start, days: num(f.days) ?? 14, opening_on_hand: opening, lines } : null;
  }
  const cogs = num(p.cogs_pct_trailing);
  return {
    as_of,
    cash: parseCash(p.cash),
    sales_by_day: sales,
    wages_by_week: wages,
    cogs_pct_trailing: cogs != null && cogs >= 0 && cogs < 1 ? cogs : null,
    cogs_basis: typeof p.cogs_basis === "string" ? p.cogs_basis : null,
    forward_cash: forward,
  };
}

export type ClosedMonth = {
  month: string; // "YYYY-MM-01"
  status: string;
  revenue: number;
  revenue_by_stream: Record<string, number>;
  cogs: number;
  gross_profit: number;
  wages: number;
  employer_tax: number;
  pre_tax_profit: number;
  rolling_12: { months: number; revenue: number; pre_tax_profit: number; seller_months: number } | null;
};

export function parseClosedMonth(p: unknown): ClosedMonth | null {
  if (!isObj(p) || p.schema !== 1) return null;
  if (typeof p.month !== "string" || !/^\d{4}-\d{2}$/.test(p.month)) return null;
  const keys = ["revenue", "cogs", "gross_profit", "wages", "employer_tax", "pre_tax_profit"] as const;
  const vals = keys.map((k) => num(p[k]));
  if (vals.some((v) => v == null)) return null;
  const [revenue, cogs, gross_profit, wages, employer_tax, pre_tax_profit] = vals as number[];
  const streams: Record<string, number> = {};
  if (isObj(p.revenue_by_stream)) for (const [k, v] of Object.entries(p.revenue_by_stream)) if (num(v) != null) streams[k] = v as number;
  let rolling: ClosedMonth["rolling_12"] = null;
  if (isObj(p.rolling_12)) {
    const r = p.rolling_12;
    if (num(r.revenue) != null && num(r.pre_tax_profit) != null)
      rolling = { months: num(r.months) ?? 12, revenue: r.revenue as number, pre_tax_profit: r.pre_tax_profit as number, seller_months: num(r.seller_months) ?? 0 };
  }
  return { month: `${p.month}-01`, status: String(p.status ?? "final"), revenue, revenue_by_stream: streams, cogs, gross_profit, wages, employer_tax, pre_tax_profit, rolling_12: rolling };
}

const cents = (n: number) => Math.round(n * 100) / 100;
const ratio = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The feed's sales as per-stream daily series for the sales charts: in-store
 * includes delivery (the targets' in-store covers both); concessions on the
 * basis the month's concessions target names (net unless 'gross').
 */
export function feedSales(d: DailySnapshot, targets: SalesTargetRow[]): StreamDaily {
  const gross = new Set(targets.filter((t) => t.stream === "concessions" && t.measure === "gross").map((t) => t.month));
  const in_store: Record<string, number> = {};
  const concessions: Record<string, number> = {};
  let anyConcessions = false;
  for (const r of d.sales_by_day) {
    in_store[r.date] = cents(r.in_store + r.delivery);
    const c = gross.has(monthStart(r.date)) ? r.concessions_gross : r.concessions;
    if (c != null) {
      concessions[r.date] = cents(c);
      anyConcessions = true;
    }
  }
  // No concessions figure on any day: the stream is still waiting, not zero.
  return anyConcessions ? { in_store, concessions } : { in_store };
}

export type LerWeek = {
  week: string;
  /** In-store + delivery + catering + concessions. */
  sales: number | null;
  grossProfit: number | null;
  /** All labor all-in, marketing work included: the whole business's labor. */
  labour: number | null;
  ler: number | null;
  withOwnerPay: number | null;
};

/**
 * Weekly LER (WEEKLY-01 section 3) on the Sunday-to-Saturday weeks Labor vs
 * target counts: the week's sales (in-store, delivery and catering as that
 * card counts them, plus concessions from the feed when it has them) times
 * (1 - trailing COGS %), an estimate because COGS is only known at the month
 * close, over the week's labor from that card with marketing work put back.
 * A week that card cannot count has no LER.
 */
export function weeklyLer(weeks: LaborTargetWeek[], cogsPct: number | null, d: DailySnapshot | null): LerWeek[] {
  const concessions = new Map((d?.sales_by_day ?? []).map((r) => [r.date, r.concessions ?? 0]));
  return weeks.map((w) => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(w.start, i));
    const sales = w.sales == null ? null : cents(w.sales + days.reduce((a, x) => a + (concessions.get(x) ?? 0), 0));
    const grossProfit = sales == null || cogsPct == null ? null : cents(sales * (1 - cogsPct));
    const labour = w.actual == null || w.marketingOffset == null ? null : cents(w.actual + w.marketingOffset);
    return { week: w.start, sales, grossProfit, labour, ...lerBoth(grossProfit, labour, "week") };
  });
}

export function closedMonthTiles(m: ClosedMonth) {
  const both = lerBoth(m.gross_profit, m.wages + m.employer_tax, "month");
  return {
    ler: both.ler,
    lerWithOwnerPay: both.withOwnerPay,
    cogsPct: m.revenue > 0 ? ratio(m.cogs / m.revenue) : null,
    preTaxPct: m.revenue > 0 ? ratio(m.pre_tax_profit / m.revenue) : null,
    rollingPct: m.rolling_12 && m.rolling_12.revenue > 0 ? ratio(m.rolling_12.pre_tax_profit / m.rolling_12.revenue) : null,
  };
}
