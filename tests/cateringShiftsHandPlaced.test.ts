// The catering shift reconciler and crew a manager placed by hand (bj-finance
// #709, crm-app #133). Before it creates open shifts for a deal with no linked
// shifts, it counts the distinct people on published Catering shifts with no
// deal_id that cover the whole event, using the noon reminder's rule, and
// creates max(0, crew - placed).
//
// The in-memory store below returns EVERY shift in the time range, filters and
// all left to the caller, so these tests prove the rule lives in the shift
// logic and not in an adapter. What the real adapters ask the database for is
// pinned in tests/cateringShiftsPg.test.ts and tests/cateringShiftRoutes.test.ts.
//
// Every name and id here is made up: this repository is public.

import { describe, expect, it } from "vitest";
import {
  createCateringShifts,
  planCateringShifts,
  reconcileShifts,
  type DealTimes,
  type ShiftStore,
} from "@/lib/cateringShifts";
import { buildReminder } from "@/lib/coverageReminder";
import { dryRunStore, runReconcileCli, type OpenStore } from "@/lib/reconcileCli";

// New York wall clock on Saturday 2026-10-24 (EDT).
const sat = (hhmm: string) => `2026-10-24T${hhmm}:00-04:00`;
const sun = (hhmm: string) => `2026-10-25T${hhmm}:00-04:00`;

// The production shape: a 2:30 to 3:30 PM event for three crew.
const EVENT: DealTimes = {
  id: 900101,
  stage: "Booked Paid",
  event_date: "2026-10-24",
  departure_time: "13:30",
  event_start_time: "14:30",
  event_end_time: "15:30",
  labor_hours: 4,
  staff_count: 3,
  cart_service: 0,
  company: "Example Co",
  venue_name: "Example Hall",
  venue_address: null,
};

type TableRow = {
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  position: string | null;
  published: boolean;
  deal_id: number | null;
  deal_slot?: number;
};

// A hand-placed shift as a manager makes it: a person, no deal, published.
function handPlaced(from: string, to: string, over: Partial<TableRow> = {}): TableRow {
  return {
    employee_id: "emp-a",
    starts_at: from,
    ends_at: to,
    position: "Catering",
    published: true,
    deal_id: null,
    ...over,
  };
}

// The three people of the production example, on shifts from 12:30 to 4:00 PM.
const FULL_CREW = ["emp-a", "emp-b", "emp-c"].map((employee_id) =>
  handPlaced(sat("12:30"), sat("16:00"), { employee_id }),
);

// An in-memory shifts table behind the seam. Its range read returns everything
// that overlaps the range, whatever its other columns say.
function memoryStore(deals: DealTimes[], rows: TableRow[] = []) {
  const table: TableRow[] = [...rows];
  const calls = { reads: 0, inserts: 0 };
  const failure = { read: false };
  const store: ShiftStore = {
    async bookedDealsWithDeparture() {
      return deals;
    },
    async dealHasShifts(dealId) {
      return table.some((s) => s.deal_id === dealId);
    },
    async handPlacedCateringShifts(range) {
      calls.reads += 1;
      if (failure.read) throw new Error("hand-placed read refused");
      return table.filter(
        (s) => Date.parse(s.starts_at) < Date.parse(range.toISO) && Date.parse(s.ends_at) > Date.parse(range.fromISO),
      );
    },
    async insertShiftsIgnoringDuplicates(inserted) {
      calls.inserts += 1;
      table.push(...inserted);
      return inserted.length;
    },
  };
  return { store, table, calls, failure };
}

const created = (table: TableRow[], dealId: number) => table.filter((s) => s.deal_id === dealId);

describe("how many open shifts a deal gets", () => {
  it("the production example: full crew placed by hand, nothing created, a clear reason", async () => {
    const db = memoryStore([EVENT], FULL_CREW);

    const result = await createCateringShifts(db.store, EVENT);

    expect(result).toEqual({ created: 0, skipped: true, reason: "crew already placed by hand (3 of 3)" });
    expect(db.calls.inserts).toBe(0);
    expect(db.table).toEqual(FULL_CREW);
  });

  it("partial crew: staff_count 3, one placed, two created on slots 1 and 2", async () => {
    const db = memoryStore([EVENT], [FULL_CREW[0]]);

    const result = await createCateringShifts(db.store, EVENT);

    expect(result).toEqual({ created: 2 });
    const rows = created(db.table, EVENT.id);
    expect(rows.map((s) => s.deal_slot)).toEqual([1, 2]);
  });

  it("the rows it does create carry the same times and notes as the plan", async () => {
    const db = memoryStore([EVENT], [FULL_CREW[0]]);
    const plan = planCateringShifts(EVENT);
    if ("skipped" in plan) throw new Error("the fixture should plan");

    await createCateringShifts(db.store, EVENT);

    expect(created(db.table, EVENT.id)).toEqual(plan.rows.slice(0, 2));
  });

  it("nobody placed: one shift per crew member, as before", async () => {
    const db = memoryStore([EVENT]);

    const result = await createCateringShifts(db.store, EVENT);

    expect(result).toEqual({ created: 3 });
    expect(created(db.table, EVENT.id).map((s) => s.deal_slot)).toEqual([1, 2, 3]);
  });

  it("more people placed than the deal asked for still creates nothing", async () => {
    const db = memoryStore([{ ...EVENT, staff_count: 2 }], FULL_CREW);

    const result = await createCateringShifts(db.store, { ...EVENT, staff_count: 2 });

    expect(result).toEqual({ created: 0, skipped: true, reason: "crew already placed by hand (3 of 2)" });
  });

  it("a deal with no staff_count defaults to one crew, and one person placed fills it", async () => {
    const deal = { ...EVENT, staff_count: null };
    const db = memoryStore([deal], [FULL_CREW[0]]);

    expect(await createCateringShifts(db.store, deal)).toEqual({
      created: 0,
      skipped: true,
      reason: "crew already placed by hand (1 of 1)",
    });
  });

  it("two shifts by the same person count once", async () => {
    const db = memoryStore(
      [EVENT],
      [handPlaced(sat("12:30"), sat("16:00")), handPlaced(sat("14:00"), sat("15:45"))],
    );

    expect(await createCateringShifts(db.store, EVENT)).toEqual({ created: 2 });
  });
});

describe("which shifts count as hand-placed crew", () => {
  it("a partial overlap does not count: 3:00 to 8:00 PM against a 7:30 to 9:00 PM event", async () => {
    const deal = { ...EVENT, event_start_time: "19:30", event_end_time: "21:00", staff_count: 1 };
    const db = memoryStore([deal], [handPlaced(sat("15:00"), sat("20:00"))]);

    expect(await createCateringShifts(db.store, deal)).toEqual({ created: 1 });
  });

  it("the exact event time counts; one minute short at either end does not", async () => {
    const deal = { ...EVENT, staff_count: 1 };
    const results = await Promise.all(
      [
        [sat("14:30"), sat("15:30")],
        [sat("14:31"), sat("15:30")],
        [sat("14:30"), sat("15:29")],
      ].map(([from, to]) => createCateringShifts(memoryStore([deal], [handPlaced(from, to)]).store, deal)),
    );
    expect(results.map((r) => r.created)).toEqual([0, 1, 1]);
  });

  it.each<[string, Partial<TableRow>]>([
    ["unpublished", { published: false }],
    ["empty (no person)", { employee_id: null }],
    ["not Catering", { position: "PENN Closer" }],
    ["no position", { position: null }],
    ["a position that only mentions Catering", { position: "Catering Lead" }],
    ["linked to another deal", { deal_id: 900999, deal_slot: 1 }],
  ])("%s does not count", async (_label, over) => {
    const deal = { ...EVENT, staff_count: 1 };
    const db = memoryStore([deal], [handPlaced(sat("12:30"), sat("16:00"), over)]);

    expect(await createCateringShifts(db.store, deal)).toEqual({ created: 1 });
  });

  it("a position with stray spaces counts, as it does for the reminder", async () => {
    const deal = { ...EVENT, staff_count: 1 };
    const db = memoryStore([deal], [handPlaced(sat("12:30"), sat("16:00"), { position: " Catering " })]);

    expect((await createCateringShifts(db.store, deal)).created).toBe(0);
  });

  it("no start time: it cannot be judged, nobody counts, and the database is not asked", async () => {
    const deal = { ...EVENT, event_start_time: null };
    const db = memoryStore([deal], FULL_CREW);

    expect(await createCateringShifts(db.store, deal)).toEqual({ created: 3 });
    expect(db.calls.reads).toBe(0);
  });

  it("no end time: the shift has to run past the start", async () => {
    const deal = { ...EVENT, event_end_time: null, staff_count: 1 };
    const past = memoryStore([deal], [handPlaced(sat("12:30"), sat("14:31"))]);
    const stopsAtStart = memoryStore([deal], [handPlaced(sat("12:30"), sat("14:30"))]);

    expect((await createCateringShifts(past.store, deal)).created).toBe(0);
    expect((await createCateringShifts(stopsAtStart.store, deal)).created).toBe(1);
  });

  it("an end earlier than the start is the next morning: crossing midnight", async () => {
    const deal = { ...EVENT, event_start_time: "22:00", event_end_time: "01:00", staff_count: 1 };
    const spans = memoryStore([deal], [handPlaced(sat("21:00"), sun("01:30"))]);
    const stopsEarly = memoryStore([deal], [handPlaced(sat("21:00"), sun("00:30"))]);

    expect((await createCateringShifts(spans.store, deal)).created).toBe(0);
    expect((await createCateringShifts(stopsEarly.store, deal)).created).toBe(1);
  });

  it("the read range reaches a late-night event and a shift that began days before", async () => {
    // 23:30 on a winter date is the next day in UTC.
    const winter = {
      ...EVENT,
      event_date: "2026-12-05",
      event_start_time: "23:30",
      event_end_time: "23:45",
      staff_count: 2,
    };
    const db = memoryStore(
      [winter],
      [
        handPlaced("2026-12-05T23:00:00-05:00", "2026-12-05T23:50:00-05:00", { employee_id: "emp-a" }),
        handPlaced("2026-12-01T09:00:00-05:00", "2026-12-06T09:00:00-05:00", { employee_id: "emp-b" }),
      ],
    );

    expect((await createCateringShifts(db.store, winter)).created).toBe(0);
  });

  it("a date no calendar has is read as nobody placed, and creates as it always did", async () => {
    const deal = { ...EVENT, event_date: "2026-13-45", staff_count: 1 };
    const db = memoryStore([deal]);

    expect((await createCateringShifts(db.store, deal)).created).toBe(1);
    expect(db.calls.reads).toBe(0);
  });
});

describe("what stays as it was", () => {
  it("a deal with a linked shift returns as today, whoever is placed, and the read is not made", async () => {
    const linked: TableRow = {
      employee_id: null,
      starts_at: sat("12:30"),
      ends_at: sat("16:30"),
      position: "Catering",
      published: true,
      deal_id: EVENT.id,
      deal_slot: 1,
    };
    const db = memoryStore([EVENT], [linked, ...FULL_CREW]);

    expect(await createCateringShifts(db.store, EVENT)).toEqual({
      created: 0,
      skipped: true,
      reason: "shifts already exist for this deal",
    });
    expect(db.calls).toEqual({ reads: 0, inserts: 0 });
    expect(db.table).toEqual([linked, ...FULL_CREW]);
  });

  it("a deal with no departure time says so, and the read is not made", async () => {
    const deal = { ...EVENT, departure_time: null };
    const db = memoryStore([deal], FULL_CREW);

    expect(await createCateringShifts(db.store, deal)).toEqual({
      created: 0,
      skipped: true,
      reason: "no departure_time yet (picklist not generated)",
    });
    expect(db.calls.reads).toBe(0);
  });

  it("hand-placed shifts keep their null deal_id: skipping links nothing", async () => {
    const db = memoryStore([EVENT], FULL_CREW);

    await reconcileShifts(db.store);

    expect(db.table.map((s) => s.deal_id)).toEqual([null, null, null]);
  });

  it("CHECK HOURS still travels with the shifts a partial crew gets", async () => {
    const deal = { ...EVENT, labor_hours: 26 };
    const db = memoryStore([deal], [FULL_CREW[0]]);

    const report = await reconcileShifts(db.store);

    expect(report.warnings).toEqual(["Deal #900101: CHECK HOURS: deal says 26h per person."]);
    expect(report.created).toBe(2);
  });

  it("a deal that creates nothing leaves no CHECK HOURS warning: no impossible shift was made", async () => {
    const db = memoryStore([{ ...EVENT, labor_hours: 26 }], FULL_CREW);

    expect((await reconcileShifts(db.store)).warnings).toEqual([]);
  });
});

describe("nothing is remembered between sweeps", () => {
  it("creates the open shifts on the next sweep once the hand-placed shift is removed", async () => {
    const db = memoryStore([EVENT], FULL_CREW);

    const first = await reconcileShifts(db.store);
    expect(first.created).toBe(0);
    expect(created(db.table, EVENT.id)).toEqual([]);

    db.table.splice(0, db.table.length);

    const second = await reconcileShifts(db.store);
    expect(second.createdFor).toEqual([{ dealId: EVENT.id, shifts: 3 }]);
    expect(created(db.table, EVENT.id).map((s) => s.deal_slot)).toEqual([1, 2, 3]);
  });

  it("once a partial crew's open shifts exist, the deal is linked and left alone", async () => {
    const db = memoryStore([EVENT], [FULL_CREW[0]]);

    await reconcileShifts(db.store);
    db.table.splice(0, 1); // the hand-placed shift goes away
    const again = await reconcileShifts(db.store);

    expect(again.created).toBe(0);
    expect(created(db.table, EVENT.id).map((s) => s.deal_slot)).toEqual([1, 2]);
  });
});

describe("a failed hand-placed read", () => {
  const OTHER: DealTimes = { ...EVENT, id: 900102, staff_count: 1 };

  it("fails that deal into the sweep's failed list and inserts nothing for it", async () => {
    const db = memoryStore([EVENT]);
    db.failure.read = true;

    const report = await reconcileShifts(db.store);

    expect(report.failed).toEqual([{ dealId: EVENT.id, message: "hand-placed read refused" }]);
    expect(report.created).toBe(0);
    expect(db.calls.inserts).toBe(0);
  });

  it("does not stop the sweep: the next deal is still tried", async () => {
    const db = memoryStore([EVENT, OTHER]);
    const read = db.store.handPlacedCateringShifts;
    let first = true;
    db.store.handPlacedCateringShifts = async (range) => {
      if (first) {
        first = false;
        throw new Error("hand-placed read refused");
      }
      return read(range);
    };

    const report = await reconcileShifts(db.store);

    expect(report.failed.map((f) => f.dealId)).toEqual([EVENT.id]);
    expect(report.createdFor).toEqual([{ dealId: OTHER.id, shifts: 1 }]);
  });

  it("throws out of createCateringShifts, so the single-deal route reports it", async () => {
    const db = memoryStore([EVENT]);
    db.failure.read = true;

    await expect(createCateringShifts(db.store, EVENT)).rejects.toThrow("hand-placed read refused");
  });
});

// Deliberate: the reconciler counts per deal and does not allocate one shift
// across overlapping events. The noon reminder does. So one person on a shift
// spanning two overlapping events skips both here, and the reminder still names
// one of them as a gap, which is how a manager hears about it.
describe("one person's shift across two overlapping events", () => {
  const EARLY: DealTimes = { ...EVENT, id: 900201, event_start_time: "14:00", event_end_time: "15:00", staff_count: 1 };
  const LATE: DealTimes = { ...EVENT, id: 900202, event_start_time: "14:30", event_end_time: "15:30", staff_count: 1 };
  const SPANNING = handPlaced(sat("12:00"), sat("18:00"));

  it("both skip, and the reminder still flags one of them", async () => {
    const db = memoryStore([EARLY, LATE], [SPANNING]);

    const report = await reconcileShifts(db.store);
    const gaps = buildReminder(
      {
        storeHours: [],
        exceptions: [],
        closedRanges: [],
        shiftTypes: [],
        shifts: [SPANNING],
        deals: [EARLY, LATE].map((d) => ({
          id: d.id,
          stage: "Booked Paid",
          archived: 0,
          event_date: d.event_date ?? null,
          event_start_time: d.event_start_time ?? null,
          event_end_time: d.event_end_time ?? null,
          staff_count: d.staff_count ?? null,
        })),
        dealShifts: [],
        staffing: [],
      },
      "2026-10-15",
    );

    expect(report.created).toBe(0);
    expect(report.failed).toEqual([]);
    expect(gaps).toEqual(["Sat Oct 24, 2:30–3:30 PM (catering)"]);
  });
});

// One event, one shift, through both real paths. The reconciler counting the
// person and the reminder calling the event covered must be the same answer.
describe("the reconciler and the reminder agree", () => {
  it.each<[string, Partial<DealTimes>, TableRow, boolean]>([
    ["spans it", {}, handPlaced(sat("12:30"), sat("16:00")), true],
    ["exact fit", {}, handPlaced(sat("14:30"), sat("15:30")), true],
    ["starts late", {}, handPlaced(sat("14:31"), sat("16:00")), false],
    ["ends early", {}, handPlaced(sat("12:30"), sat("15:29")), false],
    ["stray spaces", {}, handPlaced(sat("12:30"), sat("16:00"), { position: " Catering " }), true],
    ["unpublished", {}, handPlaced(sat("12:30"), sat("16:00"), { published: false }), false],
    ["no person", {}, handPlaced(sat("12:30"), sat("16:00"), { employee_id: null }), false],
    ["other position", {}, handPlaced(sat("12:30"), sat("16:00"), { position: "PENN Closer" }), false],
    ["linked elsewhere", {}, handPlaced(sat("12:30"), sat("16:00"), { deal_id: 900999 }), false],
    ["no start time", { event_start_time: null }, handPlaced(sat("12:30"), sat("16:00")), false],
    ["no end time, runs past", { event_end_time: null }, handPlaced(sat("12:30"), sat("14:31")), true],
    ["no end time, stops at start", { event_end_time: null }, handPlaced(sat("12:30"), sat("14:30")), false],
    ["over midnight, spans", { event_start_time: "22:00", event_end_time: "01:00" }, handPlaced(sat("21:00"), sun("01:30")), true],
    ["over midnight, short", { event_start_time: "22:00", event_end_time: "01:00" }, handPlaced(sat("21:00"), sun("00:30")), false],
  ])("%s", async (_label, over, row, covered) => {
    const deal: DealTimes = { ...EVENT, staff_count: 1, ...over };
    const db = memoryStore([deal], [row]);

    const report = await reconcileShifts(db.store);
    const gaps = buildReminder(
      {
        storeHours: [],
        exceptions: [],
        closedRanges: [],
        shiftTypes: [],
        shifts: [row],
        deals: [
          {
            id: deal.id,
            stage: "Booked Paid",
            archived: 0,
            event_date: deal.event_date ?? null,
            event_start_time: deal.event_start_time ?? null,
            event_end_time: deal.event_end_time ?? null,
            staff_count: deal.staff_count ?? null,
          },
        ],
        dealShifts: [],
        staffing: [],
      },
      "2026-10-15",
    );

    expect(report.created === 0).toBe(covered);
    expect(gaps.length === 0).toBe(covered);
  });
});

describe("the command line", () => {
  async function run(argv: string[], store: ShiftStore) {
    const out: string[] = [];
    const err: string[] = [];
    const openStore: OpenStore = async (_dsn, _opts, fn) => fn(store);
    const code = await runReconcileCli(argv, {
      env: { DATABASE_URL: "postgres://test" },
      openStore,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out, err };
  }

  it("a dry run reports the reduced count and writes nothing", async () => {
    const db = memoryStore([EVENT], [FULL_CREW[0]]);

    const r = await run(["--dry-run"], db.store);

    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "[catering-shifts] DRY RUN: scanned 1 booked deals; would create 2 shifts for 1 deals (#900101 x2)",
    ]);
    expect(db.table).toEqual([FULL_CREW[0]]);
    expect(db.calls.inserts).toBe(0);
  });

  it("a dry run passes the read through to the real store", async () => {
    const db = memoryStore([EVENT], FULL_CREW);

    await reconcileShifts(dryRunStore(db.store));

    expect(db.calls.reads).toBe(1);
  });

  it("a skipped deal reads correctly on the summary line: scanned, and no shifts", async () => {
    const r = await run([], memoryStore([EVENT], FULL_CREW).store);

    expect(r.code).toBe(0);
    expect(r.out).toEqual(["[catering-shifts] scanned 1 booked deals; created 0 shifts for 0 deals"]);
  });

  it("a failed read exits 1 and names the deal", async () => {
    const db = memoryStore([EVENT]);
    db.failure.read = true;

    const r = await run([], db.store);

    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      "[catering-shifts] scanned 1 booked deals; created 0 shifts for 0 deals; FAILED: #900101 hand-placed read refused",
    ]);
  });
});
