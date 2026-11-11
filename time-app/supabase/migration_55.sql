-- ============================================================================
-- Withers Time, migration 55: the schedulers' 8pm availability email claim
-- loses its unqualified DELETE (bj-finance #834).
-- Run once in the Supabase SQL editor, after migration_54.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_55_verify.sql. ROLLBACK. supabase/migration_55_down.sql.
--
-- WHY (bj-finance #834, under #754). The schedulers' availability email
-- (migration 48) has failed on every cron run since 2026-10-20 20:02: every
-- GET /api/cron/missed-clockins carries
-- "availabilityDigestError":"DELETE requires a WHERE clause". The cause is in
-- public.claim_availability_digest. Its final statement is
--
--     delete from public.availability_notices n
--      using fresh
--     returning n.id, n.employee_id, n.changed_date, n.changed_weekday;
--
-- A USING clause is not a WHERE clause, and the service-role connection runs
-- with the safe-update guard (the pg-safeupdate extension Supabase loads),
-- which rejects a DELETE with no WHERE. The sibling claim_shift_digests ties
-- its delete to the fresh row with "where n.employee_id = fresh.employee_id",
-- so the employee 8pm shift summary in the same route is not affected. This
-- touches only the availability claim.
--
-- WHAT THIS CHANGES. claim_availability_digest is replaced (same signature,
-- same return type, so create-or-replace suffices) with the delete tied to the
-- fresh digest row by an explicit WHERE:
--
--     delete from public.availability_notices n
--      where exists (select 1 from fresh)
--     returning ...;
--
-- Same behaviour as migration 48 intended, now with a WHERE the guard accepts:
--   * fresh holds the day's digest row when THIS call inserted it (the first
--     call for p_day), and no row otherwise (ON CONFLICT DO NOTHING on a later
--     call). "where exists (select 1 from fresh)" is true for every queued
--     notice on the first call and false on every later one — so the first
--     caller of the day takes and returns the whole queue, and a second caller
--     the same day deletes and returns nothing. The cross join the old USING
--     made had exactly this all-or-nothing effect; the WHERE states it.
--   * ONCE, EVEN WHEN TICKS OVERLAP is unchanged: the insert into
--     availability_digests and the delete from availability_notices are still
--     one statement, so a second caller at the same moment waits on the first's
--     primary-key entry, then ON CONFLICT DO NOTHING leaves fresh empty and the
--     delete removes nothing.
--   * The 60-day prune of availability_digests (its own WHERE) is unchanged.
--   * Grants are unchanged: execute revoked from public/anon/authenticated,
--     granted to service_role.
--
-- THE QUEUE SINCE 2026-10-20 IS INTACT. Every failing tick raised inside the
-- function, so the digest-day insert rolled back with it: nothing was claimed,
-- recorded or deleted. Once this is applied, the first 8pm tick claims the
-- whole waiting backlog in one catch-up email per scheduler. That is the
-- no-data-loss default; to trim the backlog first, delete the unwanted
-- availability_notices rows by hand before the first run.
--
-- ORDER WITH THE CODE. lib/availabilityNotice.ts already calls this function
-- by name with the same arguments and reads the same columns, so applying this
-- migration needs no code change and either order is safe.
-- ============================================================================

begin;

create or replace function public.claim_availability_digest(p_day date)
returns table (id bigint, employee_id uuid, changed_date date, changed_weekday smallint)
language sql
set search_path = public
as $$
  delete from public.availability_digests d where d.digest_day < p_day - 60;

  with fresh as (
    insert into public.availability_digests (digest_day)
    values (p_day)
    on conflict on constraint availability_digests_pkey do nothing
    returning availability_digests.digest_day
  )
  delete from public.availability_notices n
   where exists (select 1 from fresh)
  returning n.id, n.employee_id, n.changed_date, n.changed_weekday;
$$;

revoke execute on function public.claim_availability_digest(date) from public, anon, authenticated;
grant execute on function public.claim_availability_digest(date) to service_role;

commit;
