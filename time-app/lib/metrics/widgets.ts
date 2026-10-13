// The metrics a view can hold (bj-finance #671, v1 ruled 2026-10-10). Codes
// follow the #671 frame: D = daily, W = weekly; "Funnel" metrics are the
// sales-funnel ones that also live on this page; "Month" is the last closed
// month. `source` says where the numbers come from:
//   crm   the CRM and time-clock tables in Supabase: live today
//   feed  the bj-finance finance feed (migration 40): waiting until it runs
//   mixed some parts live, the rest waiting on the feed

import type { StreamFilter } from "./targets.ts";

export const PERIODS = ["mtd", "14d", "30d", "90d", "4w", "8w", "13w", "6m", "12m"] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABEL: Record<Period, string> = {
  mtd: "This month",
  "14d": "Next 14 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "4w": "Last 4 weeks",
  "8w": "Last 8 weeks",
  "13w": "Last 13 weeks",
  "6m": "Last 6 months",
  "12m": "Last 12 months",
};

export const METRIC_IDS = [
  "sales_vs_target",
  "cash_on_hand",
  "catering_ar",
  "weekly_ler",
  "forward_cash",
  "labour",
  "closed_month",
  "leads",
  "outreach",
  "quote_to_booking",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export type MetricDef = {
  id: MetricId;
  code: string;
  title: string;
  /** One line under the title. */
  blurb: string;
  /** A different line for some periods. */
  blurbs?: Partial<Record<Period, string>>;
  periods: Period[];
  defaultPeriod: Period;
  /** Whether the widget offers a stream filter. */
  streams: boolean;
  source: "crm" | "feed" | "mixed";
};

export const METRICS: Record<MetricId, MetricDef> = {
  sales_vs_target: {
    id: "sales_vs_target",
    code: "W1",
    title: "Sales vs target",
    blurb: "Month to date against the seasonal target, with pace. Catering by event date.",
    blurbs: { "12m": "Each month against its seasonal target: the last 12 months and the next 3. Catering by event date." },
    periods: ["mtd", "12m"],
    defaultPeriod: "mtd",
    streams: true,
    source: "mixed",
  },
  cash_on_hand: {
    id: "cash_on_hand",
    code: "D1",
    title: "Cash on hand",
    blurb: "Chase balance less outstanding cheques, and yesterday's money in and out.",
    periods: ["30d", "90d"],
    defaultPeriod: "30d",
    streams: false,
    source: "feed",
  },
  catering_ar: {
    id: "catering_ar",
    code: "W2",
    title: "Catering balances owed",
    blurb: "What customers still owe on booked events, due by the event date: overdue first, then this month.",
    periods: ["mtd"],
    defaultPeriod: "mtd",
    streams: false,
    source: "crm",
  },
  weekly_ler: {
    id: "weekly_ler",
    code: "W3",
    title: "Weekly LER",
    blurb: "Gross profit per dollar of labour, paid and unpaid owner comp. Target 2.0.",
    periods: ["8w", "13w"],
    defaultPeriod: "8w",
    streams: false,
    source: "feed",
  },
  forward_cash: {
    id: "forward_cash",
    code: "W4",
    title: "Next 14 days of cash",
    blurb: "Known money in and out over the next two weeks.",
    periods: ["14d"],
    defaultPeriod: "14d",
    streams: false,
    source: "mixed",
  },
  labour: {
    id: "labour",
    code: "W5",
    title: "Labour: hours, sales per scooper-hour, labour %",
    blurb: "Clocked hours by week, in-store and catering, and what they cost.",
    periods: ["4w", "8w", "13w"],
    defaultPeriod: "8w",
    streams: false,
    source: "mixed",
  },
  closed_month: {
    id: "closed_month",
    code: "Month",
    title: "Last closed month",
    blurb: "Pre-tax profit, monthly LER (paid and unpaid) and COGS % from the month close.",
    periods: ["6m", "12m"],
    defaultPeriod: "6m",
    streams: false,
    source: "feed",
  },
  leads: {
    id: "leads",
    code: "Funnel",
    title: "New catering enquiries",
    blurb: "Deals created each week, by how they came in.",
    periods: ["4w", "8w", "13w"],
    defaultPeriod: "8w",
    streams: false,
    source: "crm",
  },
  outreach: {
    id: "outreach",
    code: "Funnel",
    title: "Outreach emails and replies",
    blurb: "Warm and cold emails sent each week, and the replies they drew.",
    periods: ["4w", "8w", "13w"],
    defaultPeriod: "8w",
    streams: false,
    source: "crm",
  },
  quote_to_booking: {
    id: "quote_to_booking",
    code: "Funnel",
    title: "Quote to booking",
    blurb: "Of the enquiries each month that got a quote, how many booked.",
    periods: ["6m", "12m"],
    defaultPeriod: "6m",
    streams: false,
    source: "crm",
  },
};

export function blurbFor(def: MetricDef, period: Period): string {
  return def.blurbs?.[period] ?? def.blurb;
}

export type WidgetSettings = { period: Period; stream?: StreamFilter };
export type WidgetConfig = { id: string; metric: MetricId; settings: WidgetSettings };
