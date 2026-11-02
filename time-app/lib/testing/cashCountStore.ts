// An in-memory CashCountStore (lib/cashCount/store.ts) for the cash count
// tests. Test support only. It keeps the two promises the Postgres store gets
// from migration 51: one row per (store_date, kind), and a follow-up outcome
// that is only ever claimed while it is null. Tables a test leaves out are
// empty; `migrated: false` stands for the database before migration 51, and
// `fail` makes the named method throw as a lost connection would.

import type { CashCountStore, DayRows, NewReminder, Person, ReminderRow } from "../cashCount/store.ts";
import type { PlanEntry, PlanShift } from "../cashCount/plan.ts";

export type StoredReminder = ReminderRow & {
  followup_ts: string | null;
  followup_source: string | null;
  followup_at: string | null;
};

export type MemoryCashCountStore = CashCountStore & {
  migrated_: boolean;
  day: DayRows;
  shifts: PlanShift[];
  entries: PlanEntry[];
  persons: Person[];
  rows: StoredReminder[];
  /** Method names that throw on their next call. */
  fail: Set<keyof CashCountStore>;
  /** Every write the job made, in order: what a dry run must leave empty. */
  writes: string[];
};

export function memoryCashCountStore(init: Partial<Pick<MemoryCashCountStore, "day" | "shifts" | "entries" | "persons">> = {}): MemoryCashCountStore {
  let nextId = 1;
  const s: MemoryCashCountStore = {
    migrated_: true,
    day: init.day ?? { hours: [], exceptions: [], closed: [], shiftTypes: [] },
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
    async reminders(sinceDate) {
      check("reminders");
      return s.rows.filter((r) => r.store_date >= sinceDate).map((r) => ({ ...r }));
    },
    async dayRows(date) {
      check("dayRows");
      return {
        ...s.day,
        exceptions: s.day.exceptions.filter((e) => e.date === date),
        closed: s.day.closed.filter((c) => c.start_date <= date && date <= c.end_date),
      };
    },
    async punches(range) {
      check("punches");
      const inside = (iso: string, from: string, to: string) => Date.parse(iso) >= Date.parse(from) && Date.parse(iso) <= Date.parse(to);
      return {
        shifts: s.shifts.filter((x) => inside(x.starts_at, range.shiftsFrom, range.shiftsTo)),
        entries: s.entries.filter((x) => inside(x.clock_in_at, range.entriesFrom, range.entriesTo)),
      };
    },
    async people(ids) {
      check("people");
      return s.persons.filter((p) => ids.includes(p.id));
    },
    async claimReminder(row: NewReminder) {
      check("claimReminder");
      s.writes.push(`claim ${row.kind}`);
      if (s.rows.some((r) => r.store_date === row.store_date && r.kind === row.kind)) return null;
      const id = nextId++;
      s.rows.push({
        id,
        ...row,
        reminder_ts: null,
        reminder_source: null,
        posted_at: null,
        followup_outcome: null,
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
    async dropReminder(id) {
      check("dropReminder");
      s.writes.push(`drop ${id}`);
      s.rows = s.rows.filter((r) => r.id !== id);
    },
    async claimFollowup(id, outcome, at) {
      check("claimFollowup");
      s.writes.push(`followup ${id} ${outcome}`);
      const row = byId(id);
      if (row.followup_outcome !== null) return false;
      row.followup_outcome = outcome;
      if (at) row.followup_at = at;
      return true;
    },
    async settleFollowup(id, patch) {
      check("settleFollowup");
      s.writes.push(`settle ${id} ${patch.followup_outcome}`);
      Object.assign(byId(id), patch);
    },
    async prune(beforeDate) {
      check("prune");
      s.rows = s.rows.filter((r) => r.store_date >= beforeDate);
    },
  };

  function check(method: keyof CashCountStore) {
    if (s.fail.has(method)) {
      s.fail.delete(method);
      throw new Error(`connection lost (${method})`);
    }
  }
  function byId(id: number): StoredReminder {
    const row = s.rows.find((r) => r.id === id);
    if (!row) throw new Error(`no cash_count_reminders row ${id}`);
    return row;
  }
  return s;
}
