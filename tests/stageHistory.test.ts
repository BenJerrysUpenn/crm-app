// A stage move in the CRM writes deal_events, the same rows Catering-Manager's
// db.update_deal writes (modules/db.py _log_deal_events), and moving a deal to
// Booked Paid no longer says anything about money.
//
// Before this, CRM moves left no history, so the hand restores after the
// catering sweep's wrong flips could not be seen (bj-finance #750), and a
// restore to Booked Paid stamped Deposit Paid on a deal nobody had paid.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStagePatch, writeStageChange } from "@/lib/dealUpdate";

type Row = { stage: string; is_active: number };

function fakeSupabase(opts: {
  row?: Row | null;
  email?: string | null;
  readError?: string;
  updateError?: string;
  updatedRows?: number;
  insertError?: string;
}) {
  const calls = {
    updates: [] as Array<Record<string, unknown>>,
    filters: [] as Array<[string, unknown]>,
    inserts: [] as Array<Record<string, unknown>>,
  };
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
    from(table: string) {
      if (table === "deal_events") {
        return {
          insert: async (rows: Array<Record<string, unknown>>) => {
            calls.inserts.push(...rows);
            return {
              error: opts.insertError ? { message: opts.insertError } : null,
            };
          },
        };
      }
      if (table !== "deals") throw new Error(`unexpected table ${table}`);
      const updated = () => ({
        data: Array.from({ length: opts.updatedRows ?? 1 }, () => ({ id: 25419 })),
        error: opts.updateError ? { message: opts.updateError } : null,
      });
      const write = {
        eq: (col: string, val: unknown) => {
          calls.filters.push([col, val]);
          return write;
        },
        select: async () => updated(),
        then: (done: (r: unknown) => unknown) => done(updated()),
      };
      const read = {
        select: () => read,
        eq: () => read,
        maybeSingle: async () => ({
          data: opts.row === undefined ? { stage: "Booked Unpaid", is_active: 1 } : opts.row,
          error: opts.readError ? { message: opts.readError } : null,
        }),
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
    const { client, calls } = fakeSupabase({});
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
    // The write only lands if the stage is still the one that was read.
    expect(calls.filters).toEqual([
      ["id", 7],
      ["stage", "Event Complete"],
    ]);
  });

  it("writes nothing when the deal is already in that stage", async () => {
    const { client, calls } = fakeSupabase({
      row: { stage: "Booked Paid", is_active: 1 },
    });
    const res = await writeStageChange(client, 7, buildStagePatch("Booked Paid"));
    expect(res).toMatchObject({ error: null, historyError: null, changed: false });
    expect(calls.updates).toEqual([]);
    expect(calls.inserts).toEqual([]);
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
    expect(res.changed).toBe(true);
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

  it("a deal that cannot be read is not moved", async () => {
    const missing = fakeSupabase({ row: null });
    const res = await writeStageChange(missing.client, 7, buildStagePatch("Booked Paid"));
    expect(res.error?.message).toMatch(/not found/i);
    expect(missing.calls.updates).toEqual([]);

    const failed = fakeSupabase({ readError: "read failed" });
    const res2 = await writeStageChange(failed.client, 7, buildStagePatch("Booked Paid"));
    expect(res2.error?.message).toBe("read failed");
    expect(failed.calls.updates).toEqual([]);
  });
});

describe("buildStagePatch leaves payment alone", () => {
  it.each([
    [undefined],
    [null],
    [""],
    ["None"],
    ["Deposit Paid"],
    ["Paid in Full"],
  ])("moving to Booked Paid with payment %s writes no payment_status", (payment) => {
    const build = buildStagePatch as (s: string, p?: string | null) => object;
    expect(build("Booked Paid", payment)).not.toHaveProperty("payment_status");
  });

  it("still keeps is_active in step with the stage", () => {
    expect(buildStagePatch("Booked Paid").is_active).toBe(1);
    expect(buildStagePatch("Closed Lost").is_active).toBe(0);
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

  it("the board and the calendar show a history failure", () => {
    for (const path of ["components/CalendarView.tsx", "components/KanbanBoard.tsx"]) {
      expect(files.find((f) => f.path === path)!.text).toContain("historyError");
    }
  });
});
