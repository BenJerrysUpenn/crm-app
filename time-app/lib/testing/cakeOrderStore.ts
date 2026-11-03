// An in-memory CakeOrderStore (lib/cakeOrders/store.ts) for the cake order
// tests. Test support only. It keeps the two promises the Postgres store gets
// from migration 54: one row per order_key, and a follow-up outcome that is
// only ever claimed while it is null. Tables a test leaves out are empty;
// `migrated: false` stands for the database before migration 54, and `fail`
// makes the named method throw as a lost connection would.

import type { CakeOrderStore, NewOrder, OrderRow, Person } from "../cakeOrders/store.ts";
import type { PackedHow, PlanEntry, PlanShift } from "../cakeOrders/plan.ts";

export type StoredOrder = OrderRow & {
  packed_how: PackedHow | null;
  followup_ts: string | null;
  followup_source: string | null;
  followup_at: string | null;
};

export type MemoryCakeOrderStore = CakeOrderStore & {
  migrated_: boolean;
  types: { name: string; in_store: boolean | null }[];
  shifts: PlanShift[];
  entries: PlanEntry[];
  persons: Person[];
  rows: StoredOrder[];
  /** Method names that throw on their next call. */
  fail: Set<keyof CakeOrderStore>;
  /** Every write the job made, in order: what a dry run must leave empty. */
  writes: string[];
};

export function memoryCakeOrderStore(
  init: Partial<Pick<MemoryCakeOrderStore, "types" | "shifts" | "entries" | "persons">> = {},
): MemoryCakeOrderStore {
  let nextId = 1;
  const s: MemoryCakeOrderStore = {
    migrated_: true,
    types: init.types ?? [],
    shifts: init.shifts ?? [],
    entries: init.entries ?? [],
    persons: init.persons ?? [],
    rows: [],
    fail: new Set(),
    writes: [],

    async migrated() {
      check("migrated");
      return s.migrated_;
    },
    async orders(sinceIso) {
      check("orders");
      return s.rows.filter((r) => Date.parse(r.received_at) >= Date.parse(sinceIso)).map((r) => ({ ...r }));
    },
    async punches(range) {
      check("punches");
      const inside = (iso: string, from: string, to: string) => Date.parse(iso) >= Date.parse(from) && Date.parse(iso) <= Date.parse(to);
      return {
        shifts: s.shifts.filter((x) => inside(x.starts_at, range.shiftsFrom, range.shiftsTo)),
        entries: s.entries.filter((x) => inside(x.clock_in_at, range.entriesFrom, range.entriesTo)),
      };
    },
    async shiftTypes() {
      check("shiftTypes");
      return s.types;
    },
    async people(ids) {
      check("people");
      return s.persons.filter((p) => ids.includes(p.id));
    },
    async claimOrder(row: NewOrder) {
      check("claimOrder");
      s.writes.push(`claim ${row.order_key}`);
      if (s.rows.some((r) => r.order_key === row.order_key)) return null;
      const id = nextId++;
      s.rows.push({
        id,
        ...row,
        post_ts: null,
        post_source: null,
        posted_at: null,
        followup_outcome: null,
        packed_how: null,
        followup_ts: null,
        followup_source: null,
        followup_at: null,
      });
      return id;
    },
    async markPosted(id, posted) {
      check("markPosted");
      s.writes.push(`posted ${id}`);
      Object.assign(byId(id), posted);
    },
    async dropOrder(id) {
      check("dropOrder");
      s.writes.push(`drop ${id}`);
      s.rows = s.rows.filter((r) => r.id !== id);
    },
    async claimFollowup(id, outcome, at, packedHow) {
      check("claimFollowup");
      s.writes.push(`followup ${id} ${outcome}`);
      const row = byId(id);
      if (row.followup_outcome !== null) return false;
      row.followup_outcome = outcome;
      row.packed_how = packedHow ?? null;
      if (at) row.followup_at = at;
      return true;
    },
    async settleFollowup(id, patch) {
      check("settleFollowup");
      s.writes.push(`settle ${id} ${patch.followup_outcome}`);
      Object.assign(byId(id), patch);
    },
    async prune(beforeIso) {
      check("prune");
      s.rows = s.rows.filter((r) => Date.parse(r.received_at) >= Date.parse(beforeIso));
    },
  };

  function check(method: keyof CakeOrderStore) {
    if (s.fail.has(method)) {
      s.fail.delete(method);
      throw new Error(`connection lost (${method})`);
    }
  }
  function byId(id: number): StoredOrder {
    const row = s.rows.find((r) => r.id === id);
    if (!row) throw new Error(`no cake_order_reminders row ${id}`);
    return row;
  }
  return s;
}
