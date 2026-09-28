// The two web routes that create catering draft shifts, end to end against a
// stand-in Supabase whose shifts table follows Postgres's ON CONFLICT rule
// (crm-app #35).
//
//   * GET /api/cron/catering-shifts fails closed: with CRON_SECRET unset it
//     answers 503 and never opens a database client; a wrong or missing
//     secret is 401, likewise untouched; the right one, as a Bearer header or
//     ?secret=, runs the sweep.
//   * The supabase-js store's insert names exactly the columns of the unique
//     index migration 29 creates, and that index has no WHERE, so Postgres can
//     infer it. Against migration 18's partial index the same insert is
//     refused, which is the #35 break; POST /api/deals/:id/booked-shifts then
//     answers 500 with the database's words, and after migration 29 it creates
//     one shift per crew member and skips a slot that already exists.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DealTimes, ShiftRow } from "@/lib/cateringShifts";

// ---------------------------------------------------------------------------
// The unique index on shifts, read straight out of the migration files, so a
// later edit to either file is what these tests judge.
// ---------------------------------------------------------------------------

type UniqueIndex = { columns: string[]; where: string | null };

function uniqueIndexIn(file: string, name: string): UniqueIndex {
  const sql = readFileSync(resolve(__dirname, "../time-app/supabase", file), "utf8")
    // Drop comments, so the revert SQL quoted in a header is not mistaken for
    // the statement the file runs.
    .replace(/--.*$/gm, "");
  const m = new RegExp(
    `create unique index (?:if not exists )?${name}\\s+on public\\.shifts \\(([^)]*)\\)\\s*(where [^;]+)?;`,
    "i",
  ).exec(sql);
  if (!m) throw new Error(`no unique index ${name} on public.shifts in ${file}`);
  return {
    columns: m[1].split(",").map((c) => c.trim()),
    where: m[2]?.trim() ?? null,
  };
}

const MIGRATION_18 = uniqueIndexIn("migration_18.sql", "shifts_deal_slot_uidx");
const MIGRATION_29 = uniqueIndexIn("migration_29.sql", "shifts_deal_slot_uidx_plain");

// Postgres's rule for ON CONFLICT (cols) with no WHERE: it must infer a unique
// index on exactly those columns, and a partial index cannot be inferred
// without its predicate. PostgREST cannot send a predicate. Verified on
// Postgres 14 and planned on the live 17.6 database, 2026-09-27.
function infers(index: UniqueIndex, onConflict: string): boolean {
  const target = onConflict.split(",").map((c) => c.trim());
  return (
    index.where === null &&
    target.length === index.columns.length &&
    target.every((c) => index.columns.includes(c))
  );
}

// ---------------------------------------------------------------------------
// A stand-in for the shared Supabase project: the deals the sweep reads, and
// a shifts table behind whichever unique index the test installs.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => {
  const state = {
    deals: [] as Array<Record<string, unknown>>,
    shifts: [] as Array<Record<string, unknown>>,
    index: null as null | { columns: string[]; where: string | null },
    infers: null as null | ((i: { columns: string[]; where: string | null }, c: string) => boolean),
    upserts: [] as Array<{ options: unknown }>,
    adminClients: 0,
    user: { id: "manager-1" } as { id: string } | null,
  };

  function dealsTable() {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const b = {
      select: () => b,
      eq: (col: string, v: unknown) => {
        filters.push((r) => r[col] === v);
        return b;
      },
      in: (col: string, vs: unknown[]) => {
        filters.push((r) => vs.includes(r[col]));
        return b;
      },
      not: async (col: string) => ({
        data: state.deals.filter((r) => filters.every((f) => f(r)) && r[col] != null),
        error: null,
      }),
      maybeSingle: async () => ({
        data: state.deals.find((r) => filters.every((f) => f(r))) ?? null,
        error: null,
      }),
    };
    return b;
  }

  function shiftsTable() {
    let dealId: unknown = null;
    const b = {
      select: () => b,
      eq: (_col: string, v: unknown) => {
        dealId = v;
        return b;
      },
      limit: async () => ({
        data: state.shifts.filter((s) => s.deal_id === dealId).map((_, i) => ({ id: i })),
        error: null,
      }),
      upsert: (rows: Array<Record<string, unknown>>, options: { onConflict: string; ignoreDuplicates: boolean }) => {
        state.upserts.push({ options });
        return {
          select: async () => {
            if (!state.index || !state.infers!(state.index, options.onConflict)) {
              return {
                data: null,
                error: { message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" },
              };
            }
            const inserted: Array<{ id: number }> = [];
            for (const r of rows) {
              const clash =
                r.deal_id != null &&
                state.shifts.some((s) => s.deal_id === r.deal_id && s.deal_slot === r.deal_slot);
              if (clash) continue; // DO NOTHING
              state.shifts.push(r);
              inserted.push({ id: state.shifts.length });
            }
            return { data: inserted, error: null };
          },
        };
      },
    };
    return b;
  }

  const client = {
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from(table: string) {
      if (table === "deals") return dealsTable();
      if (table === "shifts") return shiftsTable();
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { state, client };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    db.state.adminClients += 1;
    return db.client;
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => db.client }));

const { GET } = await import("@/app/api/cron/catering-shifts/route");
const { POST } = await import("@/app/api/deals/[id]/booked-shifts/route");
const { supabaseShiftStore } = await import("@/lib/cateringShifts");

// A booked 8-hour event, two crew, picklist generated.
const DEAL: DealTimes = {
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

const SECRET = "cron-secret-for-tests";
const ORIGINAL_SECRET = process.env.CRON_SECRET;

function cron(query = "", headers: Record<string, string> = {}) {
  return new Request(`https://crm.test/api/cron/catering-shifts${query}`, { headers });
}

beforeEach(() => {
  db.state.deals = [{ ...DEAL }];
  db.state.shifts = [];
  db.state.index = MIGRATION_29;
  db.state.infers = infers;
  db.state.upserts = [];
  db.state.adminClients = 0;
  db.state.user = { id: "manager-1" };
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

// ---------------------------------------------------------------------------

describe("the cron route fails closed", () => {
  it("answers 503 and touches nothing when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(cron(`?secret=${SECRET}`));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("CRON_SECRET is not configured");
    expect(db.state.adminClients).toBe(0);
    expect(db.state.shifts).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["only whitespace", "   "],
  ])("treats a CRON_SECRET that is %s as unset", async (_label, value) => {
    process.env.CRON_SECRET = value;

    const response = await GET(cron(`?secret=${encodeURIComponent(value)}`, { authorization: `Bearer ${value}` }));

    expect(response.status).toBe(503);
    expect(db.state.adminClients).toBe(0);
  });

  it.each([
    ["no secret at all", cron()],
    ["a wrong ?secret=", cron("?secret=wrong-probe")],
    ["a wrong Bearer token", cron("", { authorization: "Bearer wrong-probe" })],
    ["the secret without the Bearer scheme", cron("", { authorization: SECRET })],
    ["a prefix of the secret", cron(`?secret=${SECRET.slice(0, -1)}`)],
    ["the secret with extra on the end", cron(`?secret=${SECRET}x`)],
  ])("answers 401 and touches nothing for %s", async (_label, request) => {
    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(db.state.adminClients).toBe(0);
    expect(db.state.shifts).toEqual([]);
  });

  it("runs the sweep for the right Bearer token", async () => {
    const response = await GET(cron("", { authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, scanned: 1, created: 2, deals: 1, warnings: [] });
    expect(db.state.shifts.map((s) => [s.deal_id, s.deal_slot])).toEqual([
      [25401, 1],
      [25401, 2],
    ]);
  });

  it("runs the sweep for the right ?secret=, so an existing scheduler URL keeps working", async () => {
    const response = await GET(cron(`?secret=${SECRET}`));

    expect(response.status).toBe(200);
    expect((await response.json()).created).toBe(2);
  });
});

describe("the supabase-js store's insert and the unique index", () => {
  it("targets exactly the columns migration 29 indexes, and that index is plain", () => {
    expect(MIGRATION_29).toEqual({ columns: ["deal_id", "deal_slot"], where: null });
    // Same rule as before, minus the predicate PostgREST cannot send.
    expect(MIGRATION_29.columns).toEqual(MIGRATION_18.columns);
    expect(MIGRATION_18.where).toMatch(/deal_id is not null/i);
  });

  it("sends ON CONFLICT (deal_id, deal_slot) DO NOTHING", async () => {
    await supabaseShiftStore(db.client as any).insertShiftsIgnoringDuplicates([]);
    expect(db.state.upserts[0].options).toEqual({ onConflict: "deal_id,deal_slot", ignoreDuplicates: true });
  });

  it("is refused against migration 18's partial index: the #35 break", async () => {
    db.state.index = MIGRATION_18;
    const store = supabaseShiftStore(db.client as any);

    await expect(
      store.insertShiftsIgnoringDuplicates([{ deal_id: 1, deal_slot: 1 } as ShiftRow]),
    ).rejects.toThrow("there is no unique or exclusion constraint matching the ON CONFLICT specification");
    expect(db.state.shifts).toEqual([]);
  });

  it("counts only the rows it inserted, skipping a slot that already exists", async () => {
    db.state.shifts = [{ deal_id: 1, deal_slot: 1 }];
    const store = supabaseShiftStore(db.client as any);

    const n = await store.insertShiftsIgnoringDuplicates([
      { deal_id: 1, deal_slot: 1 } as ShiftRow,
      { deal_id: 1, deal_slot: 2 } as ShiftRow,
    ]);

    expect(n).toBe(1);
    expect(db.state.shifts).toEqual([
      { deal_id: 1, deal_slot: 1 },
      { deal_id: 1, deal_slot: 2 },
    ]);
  });
});

describe("POST /api/deals/:id/booked-shifts", () => {
  function post(id: number) {
    return POST(new Request(`https://crm.test/api/deals/${id}/booked-shifts`, { method: "POST" }), {
      params: { id: String(id) },
    });
  }

  it("creates one draft shift per crew member once migration 29 is in", async () => {
    const response = await post(DEAL.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, created: 2 });
    expect(db.state.shifts).toHaveLength(2);
    expect(db.state.shifts.every((s) => s.published === false && s.employee_id === null)).toBe(true);
  });

  it("creates nothing the second time", async () => {
    await post(DEAL.id);
    const again = await post(DEAL.id);

    expect(await again.json()).toMatchObject({ created: 0, skipped: true });
    expect(db.state.shifts).toHaveLength(2);
  });

  it("answers 500 with the database's words against the partial index, as it did on live", async () => {
    db.state.index = MIGRATION_18;

    const response = await post(DEAL.id);

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe(
      "there is no unique or exclusion constraint matching the ON CONFLICT specification",
    );
    expect(db.state.shifts).toEqual([]);
  });

  it("still requires a signed-in user", async () => {
    db.state.user = null;

    const response = await post(DEAL.id);

    expect(response.status).toBe(401);
    expect(db.state.shifts).toEqual([]);
  });
});
