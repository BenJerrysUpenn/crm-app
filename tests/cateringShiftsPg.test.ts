// The direct-Postgres store's hand-placed read: what it asks the database for.
// A stand-in for the postgres.js tag records the statement and its parameters.
// The read is deliberately a little broad on position (LIKE, not =): the rule,
// including the trim the reminder applies, is decided in code, so a padded
// " Catering " has to come back from the database for the two to agree.

import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { pgShiftStore } from "@/lib/cateringShiftsPg";

function recordingSql(rows: unknown[] | Error) {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows);
  };
  return { sql: sql as unknown as postgres.Sql, calls };
}

const RANGE = { fromISO: "2026-10-23T00:00:00Z", toISO: "2026-10-26T00:00:00Z" };

describe("pgShiftStore.handPlacedCateringShifts", () => {
  it("reads published, unlinked Catering shifts with a person, overlapping the range", async () => {
    const { sql, calls } = recordingSql([]);

    await pgShiftStore(sql).handPlacedCateringShifts(RANGE);

    expect(calls).toEqual([
      {
        text:
          "select to_json(s) as row from ( " +
          "select employee_id, starts_at, ends_at, position, published, deal_id from public.shifts " +
          "where published and deal_id is null and employee_id is not null " +
          "and position like ? and starts_at < ?::timestamptz and ends_at > ?::timestamptz " +
          ") s",
        values: ["%Catering%", RANGE.toISO, RANGE.fromISO],
      },
    ]);
  });

  it("returns the rows as to_json gave them", async () => {
    const row = {
      employee_id: "emp-a",
      starts_at: "2026-10-24T12:30:00-04:00",
      ends_at: "2026-10-24T16:00:00-04:00",
      position: "Catering",
      published: true,
      deal_id: null,
    };
    const { sql } = recordingSql([{ row }]);

    expect(await pgShiftStore(sql).handPlacedCateringShifts(RANGE)).toEqual([row]);
  });

  it("lets a failed read throw, so it never reads as nobody placed", async () => {
    const { sql } = recordingSql(new Error("connection reset"));

    await expect(pgShiftStore(sql).handPlacedCateringShifts(RANGE)).rejects.toThrow("connection reset");
  });
});
