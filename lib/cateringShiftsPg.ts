import postgres from "postgres";
import {
  BOOKED_STAGES,
  DEAL_SHIFT_COLUMNS,
  type DealTimes,
  type ShiftRow,
  type ShiftStore,
} from "@/lib/cateringShifts";

// The direct-Postgres adapter for the catering shift logic, used by the local
// reconcile CLI (scripts/reconcile-catering-shifts.ts). It speaks to the same
// Supabase database the web routes reach through supabase-js, with a DSN from
// the environment instead of a service-role key.
//
// It holds no rules. Which deals get shifts, and what those shifts say, is
// decided in lib/cateringShifts.ts; this file only reads and writes rows.

// The postgres.js tagged-template client, or a transaction opened from it.
type Sql = postgres.Sql | postgres.TransactionSql;

// The deal query returns each row through to_json(), so values arrive exactly
// as PostgREST would give them to the web routes: bigint id and double
// labor_hours as JSON numbers, text as strings. Without this, postgres.js
// returns bigint as a string, and computeShiftWindow would see a different
// deal from the one the cron route sees.
export function pgShiftStore(sql: Sql): ShiftStore {
  const columns = DEAL_SHIFT_COLUMNS.split(",").map((c) => c.trim());
  return {
    async bookedDealsWithDeparture() {
      const rows = await sql<{ deal: DealTimes }[]>`
        select to_json(d) as deal
        from (
          select ${sql(columns)}
          from public.deals
          where stage in ${sql(BOOKED_STAGES)}
            and departure_time is not null
          order by id
        ) d
      `;
      return rows.map((r) => r.deal);
    },

    async dealHasShifts(dealId) {
      const rows = await sql`
        select 1 from public.shifts where deal_id = ${dealId} limit 1
      `;
      return rows.length > 0;
    },

    async insertShiftsIgnoringDuplicates(rows: ShiftRow[]) {
      if (rows.length === 0) return 0;
      const inserted = await sql`${insertShifts(sql, rows)} returning id`;
      return inserted.length;
    },

    // EXPLAIN plans the exact insert, parameters and all, without running it,
    // and is allowed inside a read-only transaction. A missing column, a type
    // Postgres will not coerce, or an ON CONFLICT it cannot match to an index
    // all fail here.
    async rehearseInsert(rows: ShiftRow[]) {
      if (rows.length === 0) return;
      await sql`explain ${insertShifts(sql, rows)}`;
    },
  };
}

// The insert both of the above share, so the rehearsal plans the statement the
// live run executes.
//
// shifts_deal_slot_uidx is a PARTIAL unique index (where deal_id is not null),
// so ON CONFLICT has to repeat that predicate or Postgres cannot infer the
// index and refuses the insert outright ("there is no unique or exclusion
// constraint matching the ON CONFLICT specification").
function insertShifts(sql: Sql, rows: ShiftRow[]) {
  return sql`
    insert into public.shifts ${sql(
      rows,
      "employee_id",
      "starts_at",
      "ends_at",
      "position",
      "notes",
      "published",
      "deal_id",
      "deal_slot",
    )}
    on conflict (deal_id, deal_slot) where deal_id is not null do nothing
  `;
}

// Open a connection from a DSN, run `fn` with a store, and always close.
//
// readOnly runs everything inside BEGIN READ ONLY, so Postgres itself refuses
// any write — the dry run does not rely on the CLI remembering not to insert.
//
// prepare: false because the Supabase transaction pooler (port 6543) does not
// support prepared statements.
export async function withPgShiftStore<T>(
  dsn: string,
  opts: { readOnly: boolean },
  fn: (store: ShiftStore) => Promise<T>,
): Promise<T> {
  const sql = postgres(dsn, { prepare: false, max: 1, onnotice: () => {} });
  try {
    if (opts.readOnly) {
      const result = await sql.begin("read only", (tx) => fn(pgShiftStore(tx)));
      return result as T;
    }
    return await fn(pgShiftStore(sql));
  } finally {
    await sql.end({ timeout: 5 });
  }
}
