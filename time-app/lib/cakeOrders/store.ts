// What the cake order reminders read and write in the database, as one
// interface. The bj-box job (scripts/cake-order-reminders.ts at the crm-app
// root) gives run.ts the direct-Postgres store in lib/cakeOrdersPg.ts; the
// tests give it the in-memory one in lib/testing/cakeOrderStore.ts. Rules live
// in plan.ts and run.ts, never here.
//
// Every method throws when the database cannot be read or written; run.ts
// decides what a failure means for the tick.

import type { Person } from "../cashCount/store";
import type { PackedHow, PlanEntry, PlanShift } from "./plan";

export type { Person };

/** What an order is recorded with before it is posted. */
export type NewOrder = {
  order_key: string;
  message_id: string;
  received_at: string;
  pickup_at: string | null;
  profile_ids: string[];
  slack_user_ids: string[];
  channel_id: string;
};

/** A cake_order_reminders row (migration 54): the recorded order, plus its post and follow-up. */
export type OrderRow = NewOrder & {
  id: number;
  post_ts: string | null;
  post_source: string | null;
  posted_at: string | null;
  followup_outcome: string | null;
};

export type CakeOrderStore = {
  /** False before migration 54: there is no cake_order_reminders table. */
  migrated(): Promise<boolean>;
  /** Orders whose email was received at `sinceIso` or later. */
  orders(sinceIso: string): Promise<OrderRow[]>;
  /** Shifts starting in [shiftsFrom, shiftsTo] and punches clocked in in [entriesFrom, entriesTo] (ISO instants). */
  punches(range: { shiftsFrom: string; shiftsTo: string; entriesFrom: string; entriesTo: string }): Promise<{ shifts: PlanShift[]; entries: PlanEntry[] }>;
  shiftTypes(): Promise<{ name: string; in_store: boolean | null }[]>;
  people(ids: string[]): Promise<Person[]>;
  /** Record an order before it is posted. Null when that order is already recorded. */
  claimOrder(row: NewOrder): Promise<number | null>;
  markPosted(id: number, posted: { post_ts: string; post_source: string; posted_at: string }): Promise<void>;
  /** Remove an order Slack refused, so the next tick tries again. */
  dropOrder(id: number): Promise<void>;
  /** Set a follow-up outcome only while it is still null. True when this call set it. */
  claimFollowup(id: number, outcome: "sending" | "not_needed" | "expired", at: string | null, packedHow?: PackedHow): Promise<boolean>;
  /** Settle a claimed follow-up: sent, failed, or released (outcome null) for the next tick. */
  settleFollowup(
    id: number,
    patch: { followup_outcome: "sent" | "failed" | null; followup_ts?: string; followup_source?: string; followup_at?: null },
  ): Promise<void>;
  /** Delete orders received before `beforeIso`. */
  prune(beforeIso: string): Promise<void>;
};
