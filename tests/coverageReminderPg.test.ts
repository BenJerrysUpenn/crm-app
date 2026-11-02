// The direct-Postgres store for the schedule coverage reminder, from the
// database to the email lines. postgres.js is the system boundary, so it is
// replaced by a stand-in database: each read gets back the columns its
// statement selects from the stand-in's rows, as to_json() would give them.
// A column the store forgets to select is a column the reminder never sees.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildReminder, reminderWindow } from "@/lib/coverageReminder";
import { withPgReminderStore } from "@/lib/coverageReminderPg";

const db = vi.hoisted(() => ({ deals: [] as Record<string, unknown>[] }));

vi.mock("postgres", () => {
  function selectedColumns(text: string, table: string): string[] {
    const m = new RegExp(`select (.+?) from public\\.${table}\\b`).exec(text);
    return m ? m[1].split(",").map((c) => c.trim()) : [];
  }
  function project(row: Record<string, unknown>, columns: string[]) {
    return Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]]));
  }
  function tx(first: unknown, ...values: unknown[]) {
    // sql(list) is the postgres.js helper for `in ${...}`, not a query.
    if (!Array.isArray(first) || !("raw" in first)) return { helper: first, values };
    const text = (first as unknown as TemplateStringsArray).join("?").replace(/\s+/g, " ");
    if (text.includes("store_hours_seasons') is not null")) return Promise.resolve([{ ready: false }]);
    if (text.includes("control_settings') is not null")) return Promise.resolve([{ board: false }]);
    if (text.includes("from public.deals")) {
      const columns = selectedColumns(text, "deals");
      return Promise.resolve(db.deals.map((d) => ({ row: project(d, columns) })));
    }
    return Promise.resolve([]);
  }
  return {
    default: () => ({
      begin: async (_mode: string, fn: (sql: typeof tx) => unknown) => fn(tx),
      end: async () => {},
    }),
  };
});

const RUN_DATE = "2026-10-15"; // a Thursday: the window runs Sun Oct 18 – Sat Oct 31

function dealRow(over: Record<string, unknown>) {
  return {
    id: 7,
    stage: "Booked Unpaid",
    archived: 0,
    event_date: "2026-10-24",
    event_start_time: "14:00",
    event_end_time: "18:00",
    staff_count: null,
    company: "Example Co",
    labor_hours: 3,
    ...over,
  };
}

async function linesFromDatabase(): Promise<string[]> {
  const snapshot = await withPgReminderStore("postgres://test", (store) =>
    store.snapshot(reminderWindow(RUN_DATE)),
  );
  return buildReminder(snapshot, RUN_DATE);
}

describe("withPgReminderStore: a deal's staff count reaches the reminder", () => {
  beforeEach(() => {
    db.deals = [];
  });

  it("a deal stored with a staff count of 0 (a customer pickup) gives no line", async () => {
    db.deals = [dealRow({ staff_count: 0 })];

    expect(await linesFromDatabase()).toEqual([]);
  });

  it("the same deal stored with no staff count is a gap", async () => {
    db.deals = [dealRow({ staff_count: null })];

    expect(await linesFromDatabase()).toEqual(["Sat Oct 24, 2:00–6:00 PM (catering)"]);
  });
});
