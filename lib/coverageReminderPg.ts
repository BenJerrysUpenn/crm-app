import postgres from "postgres";
import { STAFFING_KEYS, addDays } from "../time-app/lib/coverage";
import type {
  RecipientRow,
  ReminderDeal,
  ReminderDealShift,
  ReminderShift,
  ReminderSnapshot,
  ReminderWindow,
} from "@/lib/coverageReminder";
import type { ReminderStore } from "@/lib/coverageReminderCli";

// The direct-Postgres reads for the schedule coverage reminder (bj-finance
// #709), used by scripts/coverage-reminder.ts. It holds no rules: which hours
// and events are gaps, and who is told, is decided in lib/coverageReminder.ts.
//
// The store-hours reads mirror time-app/lib/weekCoverage.ts, the "Check week"
// button's loader: store_hours and its seasons (store_hours_seasons, migration
// 47), store_hours_exceptions, shift_types, shifts with two days of lead-in,
// "Business closed" annotations, and the open-up and close-down minutes
// (control_settings, migration 43). Unlike the button, a failed annotations
// read fails the run: a reminder that quietly lists closed days is worse than
// one that reports it could not run.
//
// Every row comes back through to_json(), so values arrive as PostgREST gives
// them to the web app: bigint as a JSON number, timestamptz as an ISO string,
// time and date as text.

async function jsonRows<T>(query: Promise<{ row: T }[]>): Promise<T[]> {
  return (await query).map((r) => r.row);
}

function pgReminderStore(sql: postgres.TransactionSql): ReminderStore {
  return {
    async snapshot(window: ReminderWindow): Promise<ReminderSnapshot> {
      const afterEnd = addDays(window.end, 1);
      // Lead-in and lead-out so a shift crossing midnight into or out of the
      // window is seen; shiftsTouchingWeek trims the rest.
      const qStart = addDays(window.start, -2) + "T00:00:00Z";
      const qEnd = addDays(window.end, 2) + "T00:00:00Z";

      const [storeHours, exceptions, shiftTypes, shifts, closedRanges, deals] = await Promise.all([
        jsonRows<ReminderSnapshot["storeHours"][number]>(sql`
          select to_json(h) as row from (
            select weekday, is_closed, opens, closes from public.store_hours
          ) h`),
        jsonRows<ReminderSnapshot["exceptions"][number]>(sql`
          select to_json(e) as row from (
            select date, label, is_closed, opens, closes from public.store_hours_exceptions
            where date >= ${window.start}::date and date < ${afterEnd}::date
          ) e`),
        jsonRows<ReminderSnapshot["shiftTypes"][number]>(sql`
          select to_json(t) as row from (select name, in_store from public.shift_types) t`),
        jsonRows<ReminderShift>(sql`
          select to_json(s) as row from (
            select starts_at, ends_at, employee_id, position, published from public.shifts
            where starts_at >= ${qStart}::timestamptz and starts_at < ${qEnd}::timestamptz
          ) s`),
        jsonRows<ReminderSnapshot["closedRanges"][number]>(sql`
          select to_json(a) as row from (
            select title, start_date, end_date from public.annotations
            where business_closed and start_date <= ${window.end}::date and end_date >= ${window.start}::date
          ) a`),
        // event_date is text (YYYY-MM-DD); every stage, the rule is applied in code.
        jsonRows<ReminderDeal>(sql`
          select to_json(d) as row from (
            select id, stage, archived, event_date, event_start_time, event_end_time from public.deals
            where event_date >= ${window.start} and event_date <= ${window.end}
            order by id
          ) d`),
      ]);

      // Store-hours seasons (migration 47, bj-finance #742): the season in
      // force on a date replaces the weekly pattern (storeHoursFor in
      // time-app/lib/coverage.ts). Before the migration there are none.
      const [{ ready }] = await sql<{ ready: boolean }[]>`select to_regclass('public.store_hours_seasons') is not null as ready`;
      const seasons = ready
        ? await jsonRows<ReminderSnapshot["storeHours"][number]>(sql`
            select to_json(s) as row from (
              select weekday, is_closed, opens, closes, effective_from from public.store_hours_seasons
            ) s`)
        : [];

      // The open-up and close-down minutes (bj-finance #742 follow-up): every
      // dated row, staffedWindow picks the one in force each day. Before
      // migration 43 there are none, and the store is checked on open hours.
      const [{ board }] = await sql<{ board: boolean }[]>`select to_regclass('public.control_settings') is not null as board`;
      const staffing = board
        ? await jsonRows<ReminderSnapshot["staffing"][number]>(sql`
            select to_json(c) as row from (
              select id, key, value::float8 as value, effective_from, recorded_at from public.control_settings
              where key in ${sql([...STAFFING_KEYS])}
            ) c`)
        : [];

      const dealIds = deals.map((d) => d.id);
      const dealShifts =
        dealIds.length === 0
          ? []
          : await jsonRows<ReminderDealShift>(sql`
              select to_json(s) as row from (
                select deal_id, employee_id, published from public.shifts
                where deal_id in ${sql(dealIds)}
              ) s`);

      return {
        storeHours: [...storeHours, ...seasons],
        exceptions,
        shiftTypes,
        shifts,
        closedRanges,
        deals,
        dealShifts,
        staffing,
      };
    },

    // Everyone with a login; lib/coverageReminder.ts selectRecipients picks
    // the owners and on-schedule managers.
    async recipientRows() {
      return jsonRows<RecipientRow>(sql`
        select to_json(r) as row from (
          select u.email, p.role, p.active, p.archived_at, u.banned_until
          from public.profiles p
          join auth.users u on u.id = p.id
        ) r`);
    },
  };
}

// Open a connection from a DSN and run `fn` inside BEGIN READ ONLY: the
// reminder never writes, and Postgres refuses it if it ever tried. Always
// closes. prepare: false because the Supabase transaction pooler (port 6543)
// does not support prepared statements.
export async function withPgReminderStore<T>(dsn: string, fn: (store: ReminderStore) => Promise<T>): Promise<T> {
  const sql = postgres(dsn, { prepare: false, max: 1, onnotice: () => {} });
  try {
    return (await sql.begin("read only", (tx) => fn(pgReminderStore(tx)))) as T;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
