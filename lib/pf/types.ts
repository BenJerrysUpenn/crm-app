// Personal-finance feed data contract (issue bj-finance#219).
//
// The pages on this side read ONE json file server-side (path from
// PF_DATA_PATH, default /var/lib/pf-feed/pf_data.json). The feed lane writes
// it daily from the Monarch export. The inner shapes mirror the ratified
// artifact generators (make_explorer.py, recurring_decisions.py,
// safe_to_spend.html) so the exporter can be checked field-for-field.

export interface PfMeta {
  /** ISO 8601 timestamp of when the feed file was generated. */
  generated_at: string;
  /** Source export filename (basename only — no private paths). */
  source: string;
  /** Number of raw transaction rows in the export. */
  row_count: number;
  reconciliation: {
    ok: boolean;
    raw_sum_cents: number;
    ledger_sum_cents: number;
  };
}

/** One classified transaction row (shape of make_explorer.py `rows`). */
export interface ExplorerRow {
  /** Date YYYY-MM-DD. */
  d: string;
  /** Merchant, truncated to 38 chars. */
  m: string;
  /** Signed amount: outflows negative, income positive. */
  a: number;
  /** Category-lens group key: debt|child|food|shop|transport|home|subs|other|income. */
  g: string;
  /** Category-lens subcategory label (e.g. "Groceries", "BNPL other"). */
  s: string;
  /** Decision-lens group key: standing|habit|oneoff|shock|pass|income. */
  g2: string;
  /** Decision-lens subcategory label. */
  s2: string;
}

export interface ExplorerData {
  /** Months shown as tabs, YYYY-MM ascending; the last one is the default. */
  months: string[];
  rows: ExplorerRow[];
  /** Emergency-fund transfer legs (both directions) for the "Kept" panel. */
  eft: { d: string; a: number }[];
}

/** One recurring stream episode (shape of recurring_streams.json). */
export interface DialStream {
  name: string;
  /** Median charge amount. */
  amt: number;
  cadence: "weekly" | "biweekly" | "monthly" | "quarterly" | "semiannual";
  /** debt|cash|payroll|transfer|bills|foodsub|subs|other. */
  cat: string;
  /** Monthly-equivalent cost. */
  permo: number;
  /** First charge date (YYYY-MM-DD or YYYY-MM), "" if unknown. */
  first: string;
  /** Last charge date, "" if unknown/forced. */
  last: string;
  active: boolean;
  /** Month (YYYY-MM) the decision started, if inside the dial window, else null. */
  start_ev: string | null;
  /** Month (YYYY-MM) the decision ended, if inside the dial window, else null. */
  end_ev: string | null;
  /** True when this episode is a re-subscribe of an earlier stream. */
  resumed: boolean;
  note: string;
}

export interface DialData {
  /** Exactly 12 months, YYYY-MM ascending; the last one is "now". */
  months: string[];
  streams: DialStream[];
}

export type HabitVerdict = "keep" | "fine" | "cap" | "trim" | "cut";

export interface SafeHabit {
  name: string;
  /** Monthly target for this habit line. */
  target: number;
  /** Actual spent on this line so far this month. */
  actual: number;
  verdict: HabitVerdict;
}

export interface SafeToSpendData {
  month: {
    /** e.g. "August 2026". */
    label: string;
    days_in_month: number;
    /** Data horizon: day-of-month the feed is verified through. */
    today: number;
    /** Expected take-home for the month (trailing basis). */
    expected_take_home: number;
    /** Standing decisions total (autopilot outflows) per month. */
    standing: number;
    /** Scheduled savings transfers per month. */
    committed_savings: number;
    /** Discretionary spent so far this month (habits + one-offs + shocks). */
    discretionary_spent: number;
  };
  /** Habit lines, targets vs actuals; targets + flex sum to the pool. */
  habits: SafeHabit[];
}

export interface PfData {
  meta: PfMeta;
  explorer: ExplorerData;
  dial: DialData;
  safe_to_spend: SafeToSpendData;
}
