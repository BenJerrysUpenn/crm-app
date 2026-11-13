-- ============================================================================
-- Withers Time, rollback for migration 55 (the schedulers' availability email
-- claim's WHERE clause). Run in the Supabase SQL editor. Safe to re-run.
--
-- This restores public.claim_availability_digest exactly as migration 48 wrote
-- it: the delete with a USING but no WHERE. That is the state before migration
-- 55, so rolling back REINTRODUCES bj-finance #834 — the service-role
-- connection's safe-update guard rejects the unqualified delete and the
-- schedulers' availability email fails on every cron run again. No data is
-- lost (the queue and the digest-day record are untouched); only the function
-- body changes back.
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
   using fresh
  returning n.id, n.employee_id, n.changed_date, n.changed_weekday;
$$;

revoke execute on function public.claim_availability_digest(date) from public, anon, authenticated;
grant execute on function public.claim_availability_digest(date) to service_role;

commit;
