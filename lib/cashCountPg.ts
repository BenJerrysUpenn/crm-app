import postgres from "postgres";
import type { CashCountStore, DayRows, Person, ReminderRow } from "../time-app/lib/cashCount/store";
import type { PlanEntry, PlanShift } from "../time-app/lib/cashCount/plan";
import type { OpenCashCountStore, VaultReader } from "../time-app/lib/cashCount/cli";

// The direct-Postgres store for the cash count reminders (crm-app #129), used
// by scripts/cash-count-reminders.ts on bj-box. It holds no rules: who is
// reminded and when is time-app/lib/cashCount/plan.ts and run.ts.
//
// It reads store hours, their seasons (migration 47) and exceptions, "Business closed"
// annotations, shift types, shifts and punches, and the profiles' names with
// the email each signs in with (auth.users, as lib/notify.ts emailForUser
// gives it). It writes only cash_count_reminders (migration 51), with the
// same guarded claims: insert ... on conflict do nothing for a reminder, and an
// update where followup_outcome is null for a follow-up.
//
// VAULT. The Slack bot token and the Claude subscription token are read from
// vault.decrypted_secrets over this same connection, the way the box's other
// jobs read Vault with secrets.env's bootstrap DSN. The values stay in memory.
//
// Every row comes back through to_json(), so values arrive as PostgREST gave
// them to the time app: bigint as a JSON number, timestamptz as an ISO string,
// time and date as text, arrays as arrays.

async function jsonRows<T>(query: Promise<{ row: T }[]>): Promise<T[]> {
  return (await query).map((r) => r.row);
}

async function tableExists(sql: postgres.Sql, name: string): Promise<boolean> {
  const [{ ready }] = await sql<{ ready: boolean }[]>`select to_regclass(${name}) is not null as ready`;
  return ready;
}

function pgCashCountStore(sql: postgres.Sql): CashCountStore {
  return {
    migrated: () => tableExists(sql, "public.cash_count_reminders"),

    reminders: (sinceDate) =>
      jsonRows<ReminderRow>(sql`
        select to_json(r) as row from (
          select id, store_date, kind, profile_ids, slack_user_ids, channel_id,
                 reminder_ts, reminder_source, posted_at, followup_outcome
          from public.cash_count_reminders where store_date >= ${sinceDate}::date
          order by id
        ) r`),

    async dayRows(date): Promise<DayRows> {
      const [hours, exceptions, closed, shiftTypes] = await Promise.all([
        jsonRows<DayRows["hours"][number]>(sql`
          select to_json(h) as row from (select weekday, is_closed, opens, closes from public.store_hours) h`),
        jsonRows<DayRows["exceptions"][number]>(sql`
          select to_json(e) as row from (
            select date, label, is_closed, opens, closes from public.store_hours_exceptions where date = ${date}::date
          ) e`),
        jsonRows<DayRows["closed"][number]>(sql`
          select to_json(a) as row from (
            select title, start_date, end_date from public.annotations
            where business_closed and start_date <= ${date}::date and end_date >= ${date}::date
          ) a`),
        jsonRows<DayRows["shiftTypes"][number]>(sql`
          select to_json(t) as row from (select name, in_store from public.shift_types) t`),
      ]);
      // Store-hours seasons (migration 47): the season in force replaces the
      // weekly pattern (lib/coverage.ts storeHoursFor). Before it, none.
      const seasons = (await tableExists(sql, "public.store_hours_seasons"))
        ? await jsonRows<DayRows["hours"][number]>(sql`
            select to_json(s) as row from (
              select weekday, is_closed, opens, closes, effective_from from public.store_hours_seasons
            ) s`)
        : [];
      return { hours: [...hours, ...seasons], exceptions, closed, shiftTypes };
    },

    async punches(range) {
      const [shifts, entries] = await Promise.all([
        jsonRows<PlanShift>(sql`
          select to_json(s) as row from (
            select id, employee_id, starts_at, ends_at, position, deal_id, published from public.shifts
            where starts_at >= ${range.shiftsFrom}::timestamptz and starts_at <= ${range.shiftsTo}::timestamptz
          ) s`),
        jsonRows<PlanEntry>(sql`
          select to_json(e) as row from (
            select id, employee_id, shift_id, clock_in_at, clock_out_at from public.time_entries
            where clock_in_at >= ${range.entriesFrom}::timestamptz and clock_in_at <= ${range.entriesTo}::timestamptz
          ) e`),
      ]);
      return { shifts, entries };
    },

    async people(ids) {
      if (ids.length === 0) return [];
      return jsonRows<Person>(sql`
        select to_json(p) as row from (
          select p.id, p.full_name, p.preferred_name, u.email
          from public.profiles p left join auth.users u on u.id = p.id
          where p.id = any(${sql.array(ids)}::uuid[])
        ) p`);
    },

    async claimReminder(row) {
      const got = await sql<{ id: string }[]>`
        insert into public.cash_count_reminders (store_date, kind, profile_ids, slack_user_ids, channel_id)
        values (${row.store_date}::date, ${row.kind}, ${sql.array(row.profile_ids)}::uuid[],
                ${sql.array(row.slack_user_ids)}::text[], ${row.channel_id})
        on conflict (store_date, kind) do nothing
        returning id::text`;
      return got.length ? Number(got[0].id) : null;
    },

    async markPosted(id, posted) {
      await sql`
        update public.cash_count_reminders
        set reminder_ts = ${posted.reminder_ts}, reminder_source = ${posted.reminder_source},
            posted_at = ${posted.posted_at}::timestamptz
        where id = ${id}`;
    },

    async dropReminder(id) {
      await sql`delete from public.cash_count_reminders where id = ${id}`;
    },

    async claimFollowup(id, outcome, at) {
      const got = await sql`
        update public.cash_count_reminders
        set followup_outcome = ${outcome}, followup_at = coalesce(${at}::timestamptz, followup_at)
        where id = ${id} and followup_outcome is null
        returning id`;
      return got.length === 1;
    },

    async settleFollowup(id, patch) {
      const set: Record<string, string | null> = { followup_outcome: patch.followup_outcome };
      if (patch.followup_ts !== undefined) set.followup_ts = patch.followup_ts;
      if (patch.followup_source !== undefined) set.followup_source = patch.followup_source;
      if (patch.followup_at !== undefined) set.followup_at = patch.followup_at;
      await sql`update public.cash_count_reminders set ${sql(set)} where id = ${id}`;
    },

    async prune(beforeDate) {
      await sql`delete from public.cash_count_reminders where store_date < ${beforeDate}::date`;
    },
  };
}

function pgVault(sql: postgres.Sql): VaultReader {
  return {
    async secret(name) {
      const got = await sql<{ value: string | null }[]>`
        select decrypted_secret as value from vault.decrypted_secrets where name = ${name} limit 1`;
      const value = got[0]?.value?.trim();
      return value ? value : null;
    },
  };
}

// Open one connection from a DSN, run `fn`, always close. Each statement is its
// own transaction, as the time app's Supabase calls were. prepare: false
// because the Supabase transaction pooler (port 6543) does not support
// prepared statements.
export const withPgCashCountStore: OpenCashCountStore = async (dsn, fn) => {
  const sql = postgres(dsn, { prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    return await fn(pgCashCountStore(sql), pgVault(sql));
  } finally {
    await sql.end({ timeout: 5 });
  }
};
