// A stage move in the CRM writes deal_events, the same rows Catering-Manager's
// db.update_deal writes (modules/db.py _log_deal_events), and moving a deal to
// Booked Paid says nothing about money.
//
// The history is what lets the hand restores after the catering sweep's wrong
// flips be seen (bj-finance #750), and a restore to Booked Paid must not stamp
// Deposit Paid on a deal nobody has paid.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStagePatch, writeStageChange } from "@/lib/dealUpdate";

type Row = { stage: string; is_active: number | null };

// The deals table as PostgREST would serve it: a read or an update reaches the
// rows whose every filter matches what they hold at that moment, and
// maybeSingle refuses more than one.
function fakeSupabase(opts: {
  /** The id of the deal the test is about. */
  id?: number;
  row?: Row | null;
  /** Other deals in the table. */
  others?: Array<Row & { id: number }>;
  email?: string | null;
  readError?: string;
  updateError?: string;
  updatedRows?: number;
  insertError?: string;
  /** The stage the row holds by the time the update runs (the sweep moved it). */
  movedMeanwhileTo?: string;
}) {
  const id = opts.id ?? 7;
  const row = opts.row === undefined ? { stage: "Booked Unpaid", is_active: 1 } : opts.row;
  const table: Array<Record<string, unknown>> = [
    ...(row ? [{ id, ...row }] : []),
    ...(opts.others ?? []),
  ];
  const calls = {
    updates: [] as Array<Record<string, unknown>>,
    /** The ids of the deals an update reached. */
    moved: [] as number[],
    inserts: [] as Array<Record<string, unknown>>,
  };
  const reached = (filters: Array<[string, unknown]>, held = table) =>
    held.filter((r) => filters.every(([col, val]) => r[col] === val));
  const client = {
    auth: {
      getUser: async () => ({
        data: {
          user:
            opts.email === null ? null : { email: opts.email ?? "chavi@example.com" },
        },
        error: null,
      }),
    },
    from(name: string) {
      if (name === "deal_events") {
        return {
          insert: async (rows: Array<Record<string, unknown>>) => {
            calls.inserts.push(...rows);
            return {
              error: opts.insertError ? { message: opts.insertError } : null,
            };
          },
        };
      }
      if (name !== "deals") throw new Error(`unexpected table ${name}`);
      const filters: Array<[string, unknown]> = [];
      const updated = () => {
        const atWrite = table.map((r) =>
          r.id === id && opts.movedMeanwhileTo ? { ...r, stage: opts.movedMeanwhileTo } : r,
        );
        const hit = opts.updateError ? [] : reached(filters, atWrite).slice(0, opts.updatedRows);
        calls.moved.push(...hit.map((r) => r.id as number));
        return {
          data: hit.map((r) => ({ id: r.id })),
          error: opts.updateError ? { message: opts.updateError } : null,
        };
      };
      const write = {
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return write;
        },
        select: async () => updated(),
        then: (done: (r: unknown) => unknown) => done(updated()),
      };
      const read = {
        select: () => read,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return read;
        },
        maybeSingle: async () => {
          if (opts.readError) return { data: null, error: { message: opts.readError } };
          const hit = reached(filters);
          if (hit.length > 1)
            return { data: null, error: { message: "multiple rows returned" } };
          const [found] = hit;
          return {
            data: found ? { stage: found.stage, is_active: found.is_active } : null,
            error: null,
          };
        },
        update: (patch: Record<string, unknown>) => {
          calls.updates.push(patch);
          return write;
        },
      };
      return read;
    },
  };
  return { client: client as never, calls };
}

describe("writeStageChange writes the history", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T15:30:07.123Z"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes a stage row shaped like catering's", async () => {
    const { client, calls } = fakeSupabase({ id: 25419 });
    const res = await writeStageChange(client, 25419, buildStagePatch("Booked Paid"));
    expect(res.error).toBeNull();
    expect(res.historyError).toBeNull();
    expect(calls.inserts).toEqual([
      {
        deal_id: 25419,
        field: "stage",
        old_value: "Booked Unpaid",
        new_value: "Booked Paid",
        // db.now_iso(): UTC, second precision, no suffix.
        at: "2026-11-02T15:30:07",
        actor: "crm:chavi@example.com",
        source: "crm-app",
      },
    ]);
  });

  it("logs is_active as text too when the move changes it", async () => {
    const { client, calls } = fakeSupabase({});
    await writeStageChange(client, 7, buildStagePatch("Event Complete"));
    expect(calls.inserts.map((r) => [r.field, r.old_value, r.new_value])).toEqual([
      ["stage", "Booked Unpaid", "Event Complete"],
      ["is_active", "1", "0"],
    ]);
  });

  it("takes the old value from the row, not from what the screen thought", async () => {
    const { client, calls } = fakeSupabase({
      row: { stage: "Event Complete", is_active: 0 },
    });
    await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(calls.inserts[0].old_value).toBe("Event Complete");
    expect(calls.inserts[1]).toMatchObject({
      field: "is_active",
      old_value: "0",
      new_value: "1",
    });
  });

  it("a deal the sweep moved while this was saving is not moved, and gets no history", async () => {
    const { client, calls } = fakeSupabase({
      row: { stage: "Sent Quote", is_active: 1 },
      movedMeanwhileTo: "Closed Lost",
    });
    const res = await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(res.error?.message).toMatch(/changed while this was saving/);
    expect(calls.inserts).toEqual([]);
  });

  it("writes nothing when the deal is already in that stage", async () => {
    const { client, calls } = fakeSupabase({
      row: { stage: "Booked Paid", is_active: 1 },
    });
    const res = await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(res).toEqual({ error: null, historyError: null });
    expect(calls.updates).toEqual([]);
    expect(calls.inserts).toEqual([]);
  });

  it("moves only the deal it was asked to move", async () => {
    const { client, calls } = fakeSupabase({
      others: [{ id: 8, stage: "Booked Unpaid", is_active: 1 }],
    });
    const res = await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(res.error).toBeNull();
    expect(calls.moved).toEqual([7]);
    expect(calls.inserts.map((r) => r.deal_id)).toEqual([7]);
  });

  it("logs a missing is_active as no old value, not the text null", async () => {
    const { client, calls } = fakeSupabase({
      row: { stage: "Sent Quote", is_active: null },
    });
    await writeStageChange(client, 7, buildStagePatch("Closed Lost"));
    expect(calls.inserts[1]).toMatchObject({
      field: "is_active",
      old_value: null,
      new_value: "0",
    });
  });

  it("names nobody it does not know", async () => {
    const { client, calls } = fakeSupabase({ email: null });
    await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(calls.inserts[0].actor).toBe("crm:unknown");
  });

  it("a failed history insert leaves the move standing, and says so", async () => {
    const { client, calls } = fakeSupabase({ insertError: "permission denied" });
    const res = await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(res.error).toBeNull();
    expect(res.historyError).toContain("permission denied");
    expect(calls.updates).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("a failed move writes no history", async () => {
    const { client, calls } = fakeSupabase({ updateError: "boom" });
    const res = await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(res.error?.message).toBe("boom");
    expect(calls.inserts).toEqual([]);
  });

  it("a move that landed on no row is an error, with no history", async () => {
    const { client, calls } = fakeSupabase({ updatedRows: 0 });
    const res = await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(res.error?.message).toMatch(/not moved/i);
    expect(calls.inserts).toEqual([]);
  });

  it("a deal that is not there is not moved", async () => {
    const { client, calls } = fakeSupabase({ row: null });
    const res = await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(res.error?.message).toMatch(/not found/i);
    expect(calls.updates).toEqual([]);
  });

  it("a deal whose read fails is not moved", async () => {
    const { client, calls } = fakeSupabase({ readError: "read failed" });
    const res = await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(res.error?.message).toBe("read failed");
    expect(calls.updates).toEqual([]);
  });
});

describe("a stage move leaves payment alone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T15:30:07.123Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moving an unpaid deal to Booked Paid writes stage, is_active and updated_at only", async () => {
    const { client, calls } = fakeSupabase({
      row: { stage: "Booked Unpaid", is_active: 1 },
    });
    await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(calls.updates).toEqual([
      { stage: "Booked Paid", is_active: 1, updated_at: "2026-11-02T15:30:07.123Z" },
    ]);
  });

  it("moving a deal to Closed Lost marks it inactive", async () => {
    const { client, calls } = fakeSupabase({});
    await writeStageChange(client, 7, buildStagePatch("Closed Lost"));
    expect(calls.updates[0]).toMatchObject({ stage: "Closed Lost", is_active: 0 });
  });
});

describe("every stage move goes through the seam", () => {
  const ROOT = resolve(__dirname, "..");
  const SKIP = new Set(["node_modules", ".next", "tests", "fixtures", "indeed-cv-downloader"]);

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (SKIP.has(name)) return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  const files = ["app", "components", "lib", "scripts", "time-app/app", "time-app/lib", "time-app/components", "time-app/scripts"]
    .flatMap((d) => {
      try {
        return sources(join(ROOT, d));
      } catch {
        return [];
      }
    })
    .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));

  it("found the source", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((f) => f.path)).toContain("lib/dealUpdate.ts");
  });

  it("nothing else writes deals.stage", () => {
    // Every update on deals in the app. A new one fails here so someone looks.
    const writers = files.flatMap(({ path, text }) =>
      [...text.matchAll(/\.from\(\s*["']deals["']\s*\)\s*\.(?:update|upsert)\(([^)]*)/g)].map(
        (m) => ({ path, arg: m[1] }),
      ),
    );
    expect(writers.map((w) => w.path).sort()).toEqual([
      "app/api/deals/[id]/calls/route.ts", // { notes }
      "components/CoiPanel.tsx", // buildCoiSentPatch
      "components/DealDetailDrawer.tsx", // the field editor's edits, below
      "components/KanbanBoard.tsx", // the payment pill
      "lib/dealUpdate.ts",
    ]);
    for (const { path, arg } of writers) {
      if (path !== "lib/dealUpdate.ts") expect(arg).not.toMatch(/\bstage\b/);
    }
  });

  it("the drawer's field editor cannot carry a stage", () => {
    const drawer = files.find((f) => f.path === "components/DealDetailDrawer.tsx")!;
    expect(drawer.text).not.toMatch(/setField\(\s*["']stage["']/);
  });

  it("each caller builds a patch and hands it to writeStageChange", () => {
    const callers = files
      .filter(({ path, text }) => path !== "lib/dealUpdate.ts" && text.includes("buildStagePatch("))
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual([
      "app/api/call-desk/calls/[eventId]/route.ts",
      "components/CalendarView.tsx",
      "components/KanbanBoard.tsx",
    ]);
    for (const path of callers) {
      expect(files.find((f) => f.path === path)!.text).toContain("writeStageChange(");
    }
  });
});
