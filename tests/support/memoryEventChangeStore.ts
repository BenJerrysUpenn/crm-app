// The second adapter of EventChangeStore (lib/eventChange.ts): plain arrays,
// no supabase client. It lets the applyEventChange / readEventPreview
// orchestration tests drive the port directly, so the branches that are
// awkward to force through the supabase-client fake — a deal that changed under
// the guard, a step that throws after the deal is saved — are a one-line setup.
// The supabase adapter at the bottom of lib/eventChange.ts is the other.

import type {
  CrewShift,
  EventChangeStore,
  EventDeal,
  ShiftMove,
} from "@/lib/eventChange";

/** A pending_calendar_actions row, the few columns the store reads and writes. */
export type QueueRow = {
  id: number;
  deal_id: number;
  action: "create" | "patch" | "delete";
  event_id: string | null;
  processed_at: string | null;
  source: string | null;
  payload?: unknown;
  new_hash?: unknown;
};

/** A crew shift with the deal it is on, which CrewShift itself does not carry. */
export type StoredShift = CrewShift & { deal_id: number };

export type MemoryDb = {
  deals: EventDeal[];
  shifts: StoredShift[];
  queue: QueueRow[];
  /** Method name -> message: the next call to that store method throws it, once. */
  fail: Partial<Record<keyof EventChangeStore, string>>;
  nextQueueId: number;
};

export function makeMemoryDb(init: Partial<MemoryDb> = {}): MemoryDb {
  return {
    deals: init.deals ?? [],
    shifts: init.shifts ?? [],
    queue: init.queue ?? [],
    fail: init.fail ?? {},
    nextQueueId: init.nextQueueId ?? 900,
  };
}

export function memoryEventChangeStore(db: MemoryDb): EventChangeStore {
  // Throw the queued failure for a method the first time it is called, the way
  // the supabase fake consumes a one-shot failWrites entry.
  const maybeFail = (method: keyof EventChangeStore) => {
    const message = db.fail[method];
    if (message) {
      delete db.fail[method];
      throw new Error(message);
    }
  };

  return {
    async readDeal(dealId) {
      maybeFail("readDeal");
      const found = db.deals.find((d) => d.id === dealId);
      // A copy, as PostgREST returns: the caller's read must not alias the row,
      // or a change made to the row after the read could not be detected.
      return found ? { ...found } : null;
    },

    async readCrewShifts(dealId) {
      maybeFail("readCrewShifts");
      return db.shifts
        .filter((s) => s.deal_id === dealId)
        .sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1))
        .map((s) => ({ ...s }));
    },

    async supersedeOpenCalendarWrites(dealId, nowNaiveUtc) {
      maybeFail("supersedeOpenCalendarWrites");
      for (const row of db.queue) {
        if (
          row.deal_id === dealId &&
          row.processed_at == null &&
          (row.action === "create" || row.action === "patch")
        ) {
          row.processed_at = nowNaiveUtc;
          row.source = `${row.source ?? ""} (superseded)`;
        }
      }
    },

    async updateDealIfUnchanged(deal, patch) {
      maybeFail("updateDealIfUnchanged");
      const current = db.deals.find((d) => d.id === deal.id);
      if (
        !current ||
        current.stage !== deal.stage ||
        current.event_date !== deal.event_date ||
        current.calendar_event_id !== deal.calendar_event_id
      ) {
        return false;
      }
      Object.assign(current, patch);
      return true;
    },

    async enqueueCalendarDelete(dealId, eventId) {
      maybeFail("enqueueCalendarDelete");
      db.queue.push({
        id: (db.nextQueueId += 1),
        deal_id: dealId,
        action: "delete",
        event_id: eventId,
        processed_at: null,
        source: "crm-app",
        payload: {},
        new_hash: null,
      });
    },

    async moveShift(dealId, move: ShiftMove, nowIsoUtc) {
      maybeFail("moveShift");
      const shift = db.shifts.find((s) => s.id === move.id && s.deal_id === dealId);
      if (!shift) throw new Error("the shift is no longer on this deal");
      shift.starts_at = move.starts_at;
      shift.ends_at = move.ends_at;
      void nowIsoUtc;
    },

    async deleteShifts(dealId, ids) {
      maybeFail("deleteShifts");
      db.shifts = db.shifts.filter((s) => !(s.deal_id === dealId && ids.includes(s.id)));
    },
  };
}
