-- ============================================================================
-- Withers Time, rollback for migration 48 (removed shifts in the summary, the
-- schedulers' availability email, weekly availability end dates).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- DATA LOST: queued "Removed" shift notices (those people will not hear the
-- shift was taken away), queued availability changes and the record of which
-- availability emails were sent, and every weekly availability row's end
-- date (those rows become open-ended again). Roll the app back first: the
-- code in bj-finance #754 writes these columns and tables.
-- ============================================================================

begin;

-- 6. weekly availability end dates.
alter table public.availability drop constraint if exists availability_repeat_until_weekly;
alter table public.availability drop column if exists repeat_until;

-- 3-5. the schedulers' availability email.
drop function if exists public.claim_availability_digest(date);
drop table if exists public.availability_digests;
drop table if exists public.availability_notices;

-- 1-2. removed shifts: the queue and the claim as migration 38 made them.
delete from public.shift_notices where notice = 'removed' or shift_id is null;
alter table public.shift_notices drop constraint if exists shift_notices_removed_check;
alter table public.shift_notices drop constraint if exists shift_notices_notice_check;
alter table public.shift_notices add constraint shift_notices_notice_check
  check (notice in ('posted', 'changed'));
alter table public.shift_notices drop column if exists former_shift_id;
alter table public.shift_notices drop column if exists starts_at;
alter table public.shift_notices drop column if exists ends_at;
alter table public.shift_notices drop column if exists position;
alter table public.shift_notices alter column shift_id set not null;

drop function if exists public.claim_shift_digests(date);
create function public.claim_shift_digests(p_day date)
returns table (employee_id uuid, shift_id bigint, notice text)
language sql
set search_path = public
as $$
  delete from public.shift_digests d where d.digest_day < p_day - 60;

  with due as (
    select distinct n.employee_id from public.shift_notices n
  ), fresh as (
    insert into public.shift_digests (employee_id, digest_day)
    select due.employee_id, p_day from due
    on conflict on constraint shift_digests_pkey do nothing
    returning shift_digests.employee_id
  )
  delete from public.shift_notices n
   using fresh
   where n.employee_id = fresh.employee_id
  returning n.employee_id, n.shift_id, n.notice;
$$;

revoke execute on function public.claim_shift_digests(date) from public, anon, authenticated;
grant execute on function public.claim_shift_digests(date) to service_role;

commit;
