import postgres from "postgres";
import type { CakeOrderStore, OrderRow, Person } from "../time-app/lib/cakeOrders/store";
import type { PlanEntry, PlanShift } from "../time-app/lib/cakeOrders/plan";
import type { OpenCakeOrderStore, VaultReader } from "../time-app/lib/cakeOrders/cli";

// The direct-Postgres store for the cake order packing reminders (crm-app
// #142), used by scripts/cake-order-reminders.ts on bj-box. It holds no rules:
// who is mentioned and when is time-app/lib/cakeOrders/plan.ts and run.ts.
// It mirrors the cash count's store (lib/cashCountPg.ts).
//
// It reads shift types, shifts and punches, and the profiles' names with the
// email each signs in with (auth.users, as lib/notify.ts emailForUser gives
// it). It writes only cake_order_reminders (migration 54), with the same
// guarded claims as the cash count: insert ... on conflict do nothing for an
// order, and an update where followup_outcome is null for a follow-up.
//
// VAULT. The Slack bot token, the mailbox login and the Claude subscription
// token are read from vault.decrypted_secrets over this same connection, the
// way the box's other jobs read Vault with secrets.env's bootstrap DSN. The
// values stay in memory.
//
// Every row comes back through to_json(), so values arrive as PostgREST gave
// them to the time app: bigint as a JSON number, timestamptz as an ISO string,
// arrays as arrays.

async function jsonRows<T>(query: Promise<{ row: T }[]>): Promise<T[]> {
  return (await query).map((r) => r.row);
}

function pgCakeOrderStore(sql: postgres.Sql): CakeOrderStore {
  return {
    async migrated() {
      const [{ ready }] = await sql<{ ready: boolean }[]>`select to_regclass('public.cake_order_reminders') is not null as ready`;
      return ready;
    },

    orders: (sinceIso) =>
      jsonRows<OrderRow>(sql`
        select to_json(r) as row from (
          select id, order_key, message_id, received_at, pickup_at, profile_ids, slack_user_ids, channel_id,
                 post_ts, post_source, posted_at, followup_outcome
          from public.cake_order_reminders where received_at >= ${sinceIso}::timestamptz
          order by id
        ) r`),

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

    shiftTypes: () =>
      jsonRows<{ name: string; in_store: boolean | null }>(sql`
        select to_json(t) as row from (select name, in_store from public.shift_types) t`),

    async people(ids) {
      if (ids.length === 0) return [];
      return jsonRows<Person>(sql`
        select to_json(p) as row from (
          select p.id, p.full_name, p.preferred_name, u.email
          from public.profiles p left join auth.users u on u.id = p.id
          where p.id = any(${sql.array(ids)}::uuid[])
        ) p`);
    },

    async claimOrder(row) {
      const got = await sql<{ id: string }[]>`
        insert into public.cake_order_reminders
          (order_key, message_id, received_at, pickup_at, profile_ids, slack_user_ids, channel_id)
        values (${row.order_key}, ${row.message_id}, ${row.received_at}::timestamptz, ${row.pickup_at}::timestamptz,
                ${sql.array(row.profile_ids)}::uuid[], ${sql.array(row.slack_user_ids)}::text[], ${row.channel_id})
        on conflict (order_key) do nothing
        returning id::text`;
      return got.length ? Number(got[0].id) : null;
    },

    async markPosted(id, posted) {
      await sql`
        update public.cake_order_reminders
        set post_ts = ${posted.post_ts}, post_source = ${posted.post_source}, posted_at = ${posted.posted_at}::timestamptz
        where id = ${id}`;
    },

    async dropOrder(id) {
      await sql`delete from public.cake_order_reminders where id = ${id}`;
    },

    async claimFollowup(id, outcome, at, packedHow) {
      const got = await sql`
        update public.cake_order_reminders
        set followup_outcome = ${outcome}, followup_at = coalesce(${at}::timestamptz, followup_at),
            packed_how = ${packedHow ?? null}
        where id = ${id} and followup_outcome is null
        returning id`;
      return got.length === 1;
    },

    async settleFollowup(id, patch) {
      const set: Record<string, string | null> = { followup_outcome: patch.followup_outcome };
      if (patch.followup_ts !== undefined) set.followup_ts = patch.followup_ts;
      if (patch.followup_source !== undefined) set.followup_source = patch.followup_source;
      if (patch.followup_at !== undefined) set.followup_at = patch.followup_at;
      await sql`update public.cake_order_reminders set ${sql(set)} where id = ${id}`;
    },

    async prune(beforeIso) {
      await sql`delete from public.cake_order_reminders where received_at < ${beforeIso}::timestamptz`;
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
export const withPgCakeOrderStore: OpenCakeOrderStore = async (dsn, fn) => {
  const sql = postgres(dsn, { prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    return await fn(pgCakeOrderStore(sql), pgVault(sql));
  } finally {
    await sql.end({ timeout: 5 });
  }
};
