// applyEventChange and readEventPreview orchestration, driven by the in-memory
// EventChangeStore (tests/support/memoryEventChangeStore.ts) rather than the
// supabase-client fake. This is the port's second adapter: it isolates the
// orchestration from PostgREST query shapes and makes the hard branches a
// one-line setup — a deal that changed under the guarded update, and a step
// that throws after the deal is saved.
//
// The end-to-end writes through the service-role adapter are
// tests/eventChangeRoute.test.ts; the pure rules are tests/eventChange.test.ts.

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyEventChange,
  readEventPreview,
  type EventChangeRequest,
  type EventDeal,
} from "@/lib/eventChange";
import {
  makeMemoryDb,
  memoryEventChangeStore,
  type MemoryDb,
  type QueueRow,
  type StoredShift,
} from "./support/memoryEventChangeStore";

const DEAL_ID = 30001;
const CTX = { now: new Date("2026-10-27T16:00:00Z"), actor: "manager@example.com" };

const RESCHEDULE: EventChangeRequest = {
  kind: "reschedule",
  event_date: "2026-11-05",
  event_start_time: "13:00",
  event_end_time: "14:30",
};

function deal(overrides: Partial<EventDeal> = {}): EventDeal {
  return {
    id: DEAL_ID,
    stage: "Booked Paid",
    event_date: "2026-10-29",
    event_start_time: "12:00",
    event_end_time: "13:30",
    calendar_event_id: "evt_old_123",
    amount_paid: 515.2,
    notes: "[2026-10-09] Earlier line.",
    picklist_docx_path: "/drive/picklists/x.docx",
    day_before_draft_sent_at: null,
    coi_sent_at: null,
    departure_time: "10:45",
    arrival_time: "11:15",
    ...overrides,
  };
}

const SHIFTS: StoredShift[] = [
  { id: 601, deal_id: DEAL_ID, employee_id: null, person: null, starts_at: "2026-10-29T15:00:00+00:00", ends_at: "2026-10-29T18:30:00+00:00" },
  { id: 602, deal_id: DEAL_ID, employee_id: "user-a", person: "Crew Member A", starts_at: "2026-10-29T15:00:00+00:00", ends_at: "2026-10-29T18:30:00+00:00" },
  { id: 700, deal_id: 30002, employee_id: null, person: null, starts_at: "2026-10-29T15:00:00+00:00", ends_at: "2026-10-29T18:30:00+00:00" },
];

const QUEUE: QueueRow[] = [
  { id: 10, deal_id: DEAL_ID, action: "patch", event_id: "evt_old_123", processed_at: null, source: "imap_idle" },
  { id: 11, deal_id: DEAL_ID, action: "delete", event_id: "evt_older", processed_at: null, source: "crm-app" },
];

let db: MemoryDb;

beforeEach(() => {
  db = makeMemoryDb({
    deals: [deal()],
    shifts: SHIFTS.map((s) => ({ ...s })),
    queue: QUEUE.map((r) => ({ ...r })),
  });
});

const row = (id: number) => db.queue.find((r) => r.id === id)!;
const stored = (id: number) => db.shifts.find((s) => s.id === id);

describe("applyEventChange over the in-memory store", () => {
  it("writes the deal, moves the deal's shifts, queues the delete and supersedes the open patch", async () => {
    const store = memoryEventChangeStore(db);
    const r = await applyEventChange(store, DEAL_ID, RESCHEDULE, [602], CTX);
    expect(r).toMatchObject({ ok: true, moved: 2, removed: 0 });
    expect(db.deals[0]).toMatchObject({ event_date: "2026-11-05", event_start_time: "13:00", calendar_event_id: null });
    expect(db.queue.find((q) => q.action === "delete" && q.event_id === "evt_old_123")).toBeTruthy();
    // Stamped with the change's time as naive UTC, the way the daemon stamps a row it processes.
    expect(row(10).processed_at).toBe("2026-10-27T16:00:00");
    expect(row(10).source).toBe("imap_idle (superseded)");
    // Another deal's shift is not touched.
    expect(stored(700)!.starts_at).toBe("2026-10-29T15:00:00+00:00");
  });

  it("answers 404 for a deal that is not there", async () => {
    db.deals = [];
    const r = await applyEventChange(memoryEventChangeStore(db), DEAL_ID, RESCHEDULE, [], CTX);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("answers 409 when the crew changed since the dialog read it, writing nothing", async () => {
    const r = await applyEventChange(memoryEventChangeStore(db), DEAL_ID, RESCHEDULE, [], CTX);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(db.deals[0].event_date).toBe("2026-10-29");
    expect(row(10).processed_at).toBeNull();
  });

  it("refuses with 409 and supersedes nothing when the deal changed under the guarded update", async () => {
    // The deal's calendar event is set by the daemon between the read and the
    // write: the guarded update refuses, and because superseding now runs only
    // after a successful update, the open patch (row 10) is left to run.
    const store = memoryEventChangeStore(db);
    const realRead = store.readDeal.bind(store);
    store.readDeal = async (id) => {
      const d = await realRead(id);
      db.deals[0].calendar_event_id = "evt_made_by_the_daemon";
      return d;
    };
    const r = await applyEventChange(store, DEAL_ID, { kind: "reschedule_tbd" }, [602], CTX);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(db.deals[0].event_date).toBe("2026-10-29");
    expect(row(10).processed_at).toBeNull();
    expect(db.queue.some((q) => q.action === "delete" && q.source === "crm-app" && q.id !== 11)).toBe(false);
    expect(db.shifts).toHaveLength(3);
  });

  it("saves the deal and says to clear the old date's queued writes by hand when superseding throws", async () => {
    db.fail.supersedeOpenCalendarWrites = "permission denied";
    const r = await applyEventChange(memoryEventChangeStore(db), DEAL_ID, RESCHEDULE, [602], CTX);
    expect(r).toMatchObject({ ok: false, status: 500 });
    if (!r.ok) {
      expect(r.error).toBe(
        "The deal was saved, but the old date's queued calendar writes could not be superseded (permission denied); they may recreate the old event — mark them done in pending_calendar_actions by hand.",
      );
    }
    // The deal is written first and stays written; the shifts still move.
    expect(db.deals[0].event_date).toBe("2026-11-05");
    // An hour before 1 PM EST on Nov 5, as the plan moves it.
    expect(stored(601)).toMatchObject({ starts_at: "2026-11-05T17:00:00.000Z", ends_at: "2026-11-05T20:30:00.000Z" });
    expect(row(10).processed_at).toBeNull();
  });

  it("saves the deal and names the shift to move by hand when a move throws", async () => {
    db.fail.moveShift = "permission denied";
    const r = await applyEventChange(memoryEventChangeStore(db), DEAL_ID, RESCHEDULE, [602], CTX);
    expect(r).toMatchObject({ ok: false, status: 500 });
    if (!r.ok) {
      expect(r.error).toBe(
        "The deal was saved, but shift 601 did not move (permission denied); move it on the Schedule page.",
      );
    }
    expect(db.deals[0].event_date).toBe("2026-11-05");
    // The first move threw; the second still ran.
    expect(stored(601)!.starts_at).toBe("2026-10-29T15:00:00+00:00");
    expect(stored(602)).toMatchObject({ starts_at: "2026-11-05T17:00:00.000Z", ends_at: "2026-11-05T20:30:00.000Z" });
  });

  it("accepts the dialog's crew list in any order and with repeats", async () => {
    db.shifts.find((s) => s.id === 601)!.employee_id = "user-b";
    const r = await applyEventChange(memoryEventChangeStore(db), DEAL_ID, RESCHEDULE, [602, 601, 602], CTX);
    expect(r).toMatchObject({ ok: true, moved: 2 });
    expect(db.deals[0].event_date).toBe("2026-11-05");
  });

  it("answers 409 when someone left the crew since the dialog read it, writing nothing", async () => {
    const r = await applyEventChange(memoryEventChangeStore(db), DEAL_ID, RESCHEDULE, [602, 603], CTX);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(db.deals[0].event_date).toBe("2026-10-29");
    expect(stored(602)!.starts_at).toBe("2026-10-29T15:00:00+00:00");
  });

  it("names every step left to do by hand when several fail after a cancel is saved", async () => {
    db.fail.enqueueCalendarDelete = "queue offline";
    db.fail.deleteShifts = "permission denied";
    const r = await applyEventChange(memoryEventChangeStore(db), DEAL_ID, { kind: "cancel" }, [602], CTX);
    expect(r).toEqual({
      ok: false,
      status: 500,
      error:
        "The deal was saved, but the old calendar event (evt_old_123) could not be queued for deletion (queue offline); delete it in Google Calendar by hand; " +
        "the crew shifts (601, 602) were not removed (permission denied); remove them on the Schedule page.",
    });
    expect(db.deals[0]).toMatchObject({ stage: "Closed Lost", calendar_event_id: null });
    expect(db.shifts.map((s) => s.id)).toEqual([601, 602, 700]);
  });
});

describe("readEventPreview over the in-memory store", () => {
  it("returns can_change, the event and every crew shift, and null for a missing deal", async () => {
    const store = memoryEventChangeStore(db);
    const preview = await readEventPreview(store, DEAL_ID);
    expect(preview).toMatchObject({
      deal: { id: DEAL_ID, can_change: true, has_calendar_event: true, amount_paid: 515.2 },
    });
    expect(preview!.shifts.map((s) => s.id)).toEqual([601, 602]);
    expect(await readEventPreview(store, 99999)).toBeNull();

    // A blank calendar id is no event, the same call the plan uses.
    db.deals[0].calendar_event_id = "   ";
    expect((await readEventPreview(store, DEAL_ID))!.deal.has_calendar_event).toBe(false);
  });

  it("says a deal past booking cannot be changed and has no calendar event when none is linked", async () => {
    db.deals = [deal({ stage: "Closed Lost", calendar_event_id: null })];
    const preview = await readEventPreview(memoryEventChangeStore(db), DEAL_ID);
    expect(preview!.deal).toMatchObject({ stage: "Closed Lost", can_change: false, has_calendar_event: false });
  });
});
