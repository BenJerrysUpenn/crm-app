// The local catering-shift reconciler (npm run reconcile-shifts), end to end
// against an in-memory shifts table.
//
// It replaces a scheduled agent that ran a July copy of the reconcile off the
// mounted Google Drive, reading its DSN from the Drive too. That copy started
// every shift an hour before departure, cart events included. These tests pin
// the stories that matter for the replacement:
//
//   * a booked deal with a departure time and no shifts gets one draft shift
//     per crew member, with the cart rule and the CHECK HOURS marker, and the
//     one summary line names it;
//   * running it again creates nothing;
//   * --dry-run reports what it would create and writes nothing, and asks the
//     store for a read-only connection;
//   * a deal whose insert fails does not stop the sweep, but the run exits 1
//     and says which deal;
//   * no DSN, or a bad argument, stops before touching the database;
//   * the cron route's supabase-js path and the CLI create identical shifts
//     and the route's response is unchanged.

import { describe, expect, it } from "vitest";
import {
  reconcileBookedDeals,
  type DealTimes,
  type ShiftRow,
  type ShiftStore,
} from "@/lib/cateringShifts";
import { runReconcileCli, type OpenStore } from "@/lib/reconcileCli";

// A booked 8-hour event departing 14:30 New York on 2026-10-10 (EDT), two crew.
const PLAIN: DealTimes = {
  id: 25401,
  stage: "Booked Paid",
  event_date: "2026-10-10",
  departure_time: "14:30",
  labor_hours: 8,
  staff_count: 2,
  cart_service: 0,
  company: "Acme",
  venue_name: "Irvine Auditorium",
  venue_address: null,
};
// The same event with the ice cream cart: the crew starts at the storage unit.
const CART: DealTimes = { ...PLAIN, id: 25402, staff_count: 1, cart_service: 1 };
// A deal whose hours are not credible (the Terrain shape: 26h per person).
const LONG: DealTimes = { ...PLAIN, id: 25403, staff_count: 1, labor_hours: 26 };

// An in-memory shifts table with the real unique (deal_id, deal_slot) rule,
// behind the ShiftStore seam. `failFor` makes one deal's insert throw.
function memoryStore(deals: DealTimes[], opts: { existing?: ShiftRow[]; failFor?: number } = {}) {
  const shifts: ShiftRow[] = [...(opts.existing ?? [])];
  const calls = { inserts: 0, rehearsals: 0 };
  const store: ShiftStore = {
    async bookedDealsWithDeparture() {
      return deals.filter(
        (d) => (d.stage === "Booked Unpaid" || d.stage === "Booked Paid") && d.departure_time != null,
      );
    },
    async dealHasShifts(dealId) {
      return shifts.some((s) => s.deal_id === dealId);
    },
    async insertShiftsIgnoringDuplicates(rows) {
      calls.inserts += 1;
      if (rows.some((r) => r.deal_id === opts.failFor)) throw new Error("insert refused");
      let n = 0;
      for (const r of rows) {
        if (shifts.some((s) => s.deal_id === r.deal_id && s.deal_slot === r.deal_slot)) continue;
        shifts.push(r);
        n += 1;
      }
      return n;
    },
    async rehearseInsert() {
      calls.rehearsals += 1;
    },
  };
  return { store, shifts, calls };
}

// Run the CLI against a store, capturing what it prints and what it asked for.
async function run(argv: string[], store: ShiftStore, env: Record<string, string | undefined> = { DATABASE_URL: "postgres://test" }) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: { dsn: string; readOnly: boolean }[] = [];
  const openStore: OpenStore = async (dsn, o, fn) => {
    opened.push({ dsn, readOnly: o.readOnly });
    return fn(store);
  };
  const code = await runReconcileCli(argv, {
    env,
    openStore,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err, opened };
}

describe("a live run", () => {
  it("creates one draft shift per crew member for a booked deal with no shifts", async () => {
    const db = memoryStore([PLAIN]);
    const r = await run([], db.store);

    expect(r.code).toBe(0);
    expect(db.shifts).toHaveLength(2);
    expect(db.shifts.map((s) => s.deal_slot)).toEqual([1, 2]);
    for (const s of db.shifts) {
      expect(s.employee_id).toBeNull();
      expect(s.published).toBe(false);
      expect(s.position).toBe("Catering");
      expect(s.starts_at).toBe("2026-10-10T17:30:00.000Z"); // 13:30 EDT, 1h before departure
      expect(s.ends_at).toBe("2026-10-11T01:30:00.000Z"); // 21:30 EDT
    }
    expect(r.out).toEqual([
      "[catering-shifts] scanned 1 booked deals; created 2 shifts for 1 deals (#25401 x2)",
    ]);
    expect(r.opened).toEqual([{ dsn: "postgres://test", readOnly: false }]);
  });

  it("starts a cart event's shift two hours before departure, not one", async () => {
    const db = memoryStore([CART]);
    await run([], db.store);
    expect(db.shifts).toHaveLength(1);
    expect(db.shifts[0].starts_at).toBe("2026-10-10T16:30:00.000Z"); // 12:30 EDT
    expect(db.shifts[0].ends_at).toBe("2026-10-11T01:30:00.000Z"); // end unchanged
    expect(db.shifts[0].notes).toContain("Cart event: start at the storage unit");
  });

  it("puts CHECK HOURS on the summary line and first in the shift note", async () => {
    const db = memoryStore([LONG]);
    const r = await run([], db.store);
    expect(r.code).toBe(0);
    expect(db.shifts[0].notes.startsWith("CHECK HOURS: deal says 26h per person.")).toBe(true);
    expect(r.out[0]).toBe(
      "[catering-shifts] scanned 1 booked deals; created 1 shifts for 1 deals (#25403 x1); warnings: Deal #25403: CHECK HOURS: deal says 26h per person.",
    );
  });

  it("creates nothing the second time", async () => {
    const db = memoryStore([PLAIN, CART]);
    await run([], db.store);
    const again = await run([], db.store);
    expect(again.code).toBe(0);
    expect(db.shifts).toHaveLength(3);
    expect(again.out).toEqual(["[catering-shifts] scanned 2 booked deals; created 0 shifts for 0 deals"]);
  });

  it("leaves a deal that already has any shift alone", async () => {
    const existing: ShiftRow = {
      employee_id: "someone",
      starts_at: "2026-10-10T17:30:00.000Z",
      ends_at: "2026-10-11T01:30:00.000Z",
      position: "Catering",
      notes: "edited by a manager",
      published: true,
      deal_id: PLAIN.id,
      deal_slot: 1,
    };
    const db = memoryStore([PLAIN], { existing: [existing] });
    await run([], db.store);
    expect(db.shifts).toEqual([existing]);
    expect(db.calls.inserts).toBe(0);
  });

  it("ignores deals that are not booked or have no departure time yet", async () => {
    const db = memoryStore([
      { ...PLAIN, id: 1, stage: "Quote Sent" },
      { ...PLAIN, id: 2, departure_time: null },
    ]);
    const r = await run([], db.store);
    expect(db.shifts).toHaveLength(0);
    expect(r.out[0]).toBe("[catering-shifts] scanned 0 booked deals; created 0 shifts for 0 deals");
  });
});

describe("--dry-run", () => {
  it("reports what it would create and writes nothing", async () => {
    const db = memoryStore([PLAIN, CART, LONG]);
    const r = await run(["--dry-run"], db.store);

    expect(r.code).toBe(0);
    expect(db.shifts).toHaveLength(0);
    expect(db.calls.inserts).toBe(0);
    expect(r.out).toEqual([
      "[catering-shifts] DRY RUN: scanned 3 booked deals; would create 4 shifts for 3 deals (#25401 x2, #25402 x1, #25403 x1); warnings: Deal #25403: CHECK HOURS: deal says 26h per person.",
    ]);
  });

  it("asks for a read-only connection", async () => {
    const r = await run(["--dry-run"], memoryStore([PLAIN]).store);
    expect(r.opened).toEqual([{ dsn: "postgres://test", readOnly: true }]);
  });

  it("rehearses each insert when the store can, so a refused insert fails the dry run", async () => {
    const db = memoryStore([PLAIN, CART]);
    await run(["--dry-run"], db.store);
    expect(db.calls.rehearsals).toBe(2);

    const refusing = memoryStore([PLAIN]);
    refusing.store.rehearseInsert = async () => {
      throw new Error("there is no unique or exclusion constraint matching the ON CONFLICT specification");
    };
    const r = await run(["--dry-run"], refusing.store);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("FAILED: #25401 there is no unique or exclusion constraint");
  });
});

describe("when something goes wrong", () => {
  it("keeps sweeping past a deal whose insert fails, then exits 1 naming it", async () => {
    const db = memoryStore([PLAIN, CART], { failFor: PLAIN.id });
    const r = await run([], db.store);
    expect(r.code).toBe(1);
    expect(db.shifts.map((s) => s.deal_id)).toEqual([CART.id]);
    expect(r.out).toEqual([]);
    expect(r.err).toEqual([
      "[catering-shifts] scanned 2 booked deals; created 1 shifts for 1 deals (#25402 x1); FAILED: #25401 insert refused",
    ]);
  });

  it("exits 1 when the deals cannot be read at all", async () => {
    const db = memoryStore([]);
    db.store.bookedDealsWithDeparture = async () => {
      throw new Error("connection refused");
    };
    const r = await run([], db.store);
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["[catering-shifts] ERROR: connection refused"]);
  });

  it("exits 2 without opening a connection when DATABASE_URL is missing", async () => {
    const r = await run([], memoryStore([PLAIN]).store, {});
    expect(r.code).toBe(2);
    expect(r.opened).toEqual([]);
    expect(r.err[0]).toContain("DATABASE_URL is not set");
  });

  it("exits 2 on an unknown argument rather than guessing, so a typo never writes", async () => {
    const r = await run(["--dryrun"], memoryStore([PLAIN]).store);
    expect(r.code).toBe(2);
    expect(r.opened).toEqual([]);
    expect(r.err[0]).toContain("unknown argument: --dryrun");
  });
});

// ---------------------------------------------------------------------------
// One source of truth: the cron route (supabase-js) and the CLI (any store)
// run the same sweep. A stand-in supabase client records what the route path
// writes; it must be exactly what the CLI path writes, and the route's
// response keeps its four fields.
// ---------------------------------------------------------------------------

function fakeSupabase(deals: DealTimes[], opts: { failFor?: number } = {}) {
  const upserts: { rows: ShiftRow[]; options: unknown }[] = [];
  const client = {
    from(table: string) {
      if (table === "deals") {
        const b = {
          select: () => b,
          in: () => b,
          not: async () => ({ data: deals, error: null }),
        };
        return b;
      }
      if (table === "shifts") {
        let pending: ShiftRow[] = [];
        const b = {
          select: () => b,
          eq: () => b,
          limit: async () => ({ data: [], error: null }),
          upsert: (rows: ShiftRow[], options: unknown) => {
            pending = rows;
            upserts.push({ rows, options });
            return {
              select: async () =>
                rows.some((r) => r.deal_id === opts.failFor)
                  ? { data: null, error: { message: "upsert refused" } }
                  : { data: pending.map((_, i) => ({ id: i })), error: null },
            };
          },
        };
        return b;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, upserts };
}

describe("the cron route and the CLI share one sweep", () => {
  it("write identical shift rows for the same deals", async () => {
    const deals = [PLAIN, CART, LONG];
    const sb = fakeSupabase(deals);
    await reconcileBookedDeals(sb.client as any);

    const db = memoryStore(deals);
    await run([], db.store);

    expect(sb.upserts.flatMap((u) => u.rows)).toEqual(db.shifts);
    expect(sb.upserts[0].options).toEqual({ onConflict: "deal_id,deal_slot", ignoreDuplicates: true });
  });

  it("keeps the route's response to the same four fields, and still swallows a failed deal", async () => {
    const sb = fakeSupabase([PLAIN, LONG], { failFor: PLAIN.id });
    const result = await reconcileBookedDeals(sb.client as any);
    expect(result).toEqual({
      scanned: 2,
      created: 1,
      deals: 1,
      warnings: ["Deal #25403: CHECK HOURS: deal says 26h per person."],
    });
  });
});
