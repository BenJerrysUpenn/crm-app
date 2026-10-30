// What the cash count reminders read and write in the database, as one
// interface. The bj-box job (scripts/cash-count-reminders.ts at the crm-app
// root) gives run.ts the direct-Postgres store in lib/cashCountPg.ts; the tests
// give it the in-memory one in lib/testing/cashCountStore.ts. Rules live in
// plan.ts and run.ts, never here.
//
// Every method throws when the database cannot be read or written; run.ts
// decides what a failure means for the tick.

import type { ClosedDateRange, StoreHoursException, StoreHoursRow } from "../coverage";
import type { PlanEntry, PlanShift, ReminderKind } from "./plan";

/** A cash_count_reminders row (migration 51). */
export type ReminderRow = {
  id: number;
  store_date: string;
  kind: ReminderKind;
  profile_ids: string[];
  slack_user_ids: string[];
  channel_id: string;
  reminder_ts: string | null;
  reminder_source: string | null;
  posted_at: string | null;
  followup_outcome: string | null;
};

/** One day's store hours, as lib/coverage.ts resolveOpenWindow reads them. */
export type DayRows = {
  /** The weekly pattern and every store-hours season row (effective_from set). */
  hours: StoreHoursRow[];
  exceptions: StoreHoursException[];
  /** "Business closed" annotations covering the day. */
  closed: ClosedDateRange[];
  shiftTypes: { name: string; in_store: boolean | null }[];
};

/** A profile's names and the email they sign in to the time app with. */
export type Person = { id: string; full_name: string | null; preferred_name: string | null; email: string | null };

export type NewReminder = {
  store_date: string;
  kind: ReminderKind;
  profile_ids: string[];
  slack_user_ids: string[];
  channel_id: string;
};

export type CashCountStore = {
  /** False before migration 51: there is no cash_count_reminders table. */
  migrated(): Promise<boolean>;
  /** Reminders recorded for `sinceDate` or later. */
  reminders(sinceDate: string): Promise<ReminderRow[]>;
  dayRows(date: string): Promise<DayRows>;
  /** Shifts starting in [shiftsFrom, shiftsTo] and punches clocked in in [entriesFrom, entriesTo] (ISO instants). */
  punches(range: { shiftsFrom: string; shiftsTo: string; entriesFrom: string; entriesTo: string }): Promise<{ shifts: PlanShift[]; entries: PlanEntry[] }>;
  people(ids: string[]): Promise<Person[]>;
  /** Record a reminder before it is posted. Null when one of that kind is already recorded for that day. */
  claimReminder(row: NewReminder): Promise<number | null>;
  markPosted(id: number, posted: { reminder_ts: string; reminder_source: string; posted_at: string }): Promise<void>;
  /** Remove a reminder Slack refused, so the next tick tries again. */
  dropReminder(id: number): Promise<void>;
  /** Set a follow-up outcome only while it is still null. True when this call set it. */
  claimFollowup(id: number, outcome: "sending" | "not_needed" | "expired", at: string | null): Promise<boolean>;
  /** Settle a claimed follow-up: sent, failed, or released (outcome null) for the next tick. */
  settleFollowup(
    id: number,
    patch: { followup_outcome: "sent" | "failed" | null; followup_ts?: string; followup_source?: string; followup_at?: null },
  ): Promise<void>;
  /** Delete reminders older than `beforeDate`. */
  prune(beforeDate: string): Promise<void>;
};
