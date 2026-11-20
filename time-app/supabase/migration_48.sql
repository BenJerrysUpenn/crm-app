-- ============================================================================
-- Withers Time, migration 48: removed shifts in the 8pm summary, the
-- schedulers' availability email, and an end date for weekly availability
-- Run once in the Supabase SQL editor, after migration_47.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_48_verify.sql. ROLLBACK. supabase/migration_48_down.sql.
--
-- WHY (bj-finance #754). The owner asked for three things:
--   * staff hear every day what changed on their schedule, and which day.
--     The 8pm summary (migration 38) left out a shift that was deleted or
--     moved to someone else, so a person whose shift was taken away heard
--     nothing. It now carries a "Removed" line for it.
--   * schedulers get an email when someone changes their availability: one a
--     day, at 8pm, from the same cron tick as the shift summary.
--   * weekly availability repeats until a date, not forever.
--
-- WHAT THIS ADDS
--   1. shift_notices gains 'removed'. A removed notice names the shift in
--      former_shift_id (no foreign key: the shift may be gone) and keeps the
--      shift's day and times as the person last had them (starts_at, ends_at,
--      position), so the summary can say which day. shift_id stays the
--      cascading reference for 'posted' and 'changed' and is null on a
--      removed notice, so deleting the shift does not delete the notice
--      saying it was taken away.
--   2. claim_shift_digests(p_day) returns those columns too, and the queue id
--      (the order the notices were written in). Its return type changes, so
--      it is dropped and created again inside this transaction.
--   3. availability_notices: the schedulers' queue. Each change an employee
--      makes to their own availability adds a row per date (changed_date) or
--      weekday (changed_weekday) it touched; lib/availabilityNotice.ts writes
--      it with the service-role key.
--   4. availability_digests: one row per New York day the schedulers'
--      email was claimed for. The primary key is what makes it once a day.
--   5. claim_availability_digest(p_day): on the first call for p_day it
--      records the day and takes every queued notice, returning them; any
--      later call that day returns nothing, and what is queued after waits
--      for the next day. Rows older than 60 days are pruned as it goes.
--   6. availability.repeat_until: the last date a weekly row applies. Null
--      means open-ended, which is what every existing row stays until its
--      person next saves it. Only a weekly row (weekday set) may carry one.
--
-- ONCE, EVEN WHEN TICKS OVERLAP. As in migration 38: the insert into
-- availability_digests and the delete from availability_notices are one
-- statement, and a second caller at the same moment waits on the first one's
-- primary-key entry, then ON CONFLICT DO NOTHING leaves it with nothing to
-- delete or return.
--
-- WHO MAY TOUCH IT. The new tables and function: the service role alone (RLS
-- on, no policies, table privileges and execute revoked from anon and
-- authenticated). availability.repeat_until is under availability's existing
-- policies.
--
-- ORDER WITH THE CODE. Either order is safe. Applied first: the code live
-- today never writes the new columns or tables, and reads claim_shift_digests
-- by column name, so the extra columns pass it by. Code first: a removed or
-- availability notice cannot be queued (logged, not fatal; the save is made),
-- and saving weekly availability is refused with a message until this runs.
-- ============================================================================

begin;

-- ---- 1. removed shifts -------------------------------------------------------------
alter table public.shift_notices alter column shift_id drop not null;
alter table public.shift_notices add column if not exists former_shift_id bigint;
alter table public.shift_notices add column if not exists starts_at timestamptz;
alter table public.shift_notices add column if not exists ends_at timestamptz;
alter table public.shift_notices add column if not exists position text;

alter table public.shift_notices drop constraint if exists shift_notices_notice_check;
alter table public.shift_notices add constraint shift_notices_notice_check
  check (notice in ('posted', 'changed', 'removed'));

alter table public.shift_notices drop constraint if exists shift_notices_removed_check;
alter table public.shift_notices add constraint shift_notices_removed_check
  check (
    case when notice = 'removed'
      then shift_id is null and former_shift_id is not null and starts_at is not null and ends_at is not null
      else shift_id is not null
    end
  );

-- ---- 2. the claim returns what a removed line needs -------------------------------
drop function if exists public.claim_shift_digests(date);
create function public.claim_shift_digests(p_day date)
returns table (
  id              bigint,
  employee_id     uuid,
  shift_id        bigint,
  notice          text,
  former_shift_id bigint,
  starts_at       timestamptz,
  ends_at         timestamptz,
  "position"      text
)
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
  returning n.id, n.employee_id, n.shift_id, n.notice, n.former_shift_id, n.starts_at, n.ends_at, n."position";
$$;

revoke execute on function public.claim_shift_digests(date) from public, anon, authenticated;
grant execute on function public.claim_shift_digests(date) to service_role;

-- ---- 3-5. the schedulers' availability email ------------------------------------------
create table if not exists public.availability_notices (
  id              bigint generated always as identity primary key,
  employee_id     uuid        not null references public.profiles (id) on delete cascade,
  changed_date    date,
  changed_weekday smallint,
  queued_at       timestamptz not null default now(),
  constraint availability_notices_what check ((changed_date is null) <> (changed_weekday is null)),
  constraint availability_notices_weekday check (changed_weekday is null or changed_weekday between 0 and 6)
);

create table if not exists public.availability_digests (
  -- The New York day whose 8pm email this was.
  digest_day date        primary key,
  claimed_at timestamptz not null default now()
);

alter table public.availability_notices enable row level security;
alter table public.availability_digests enable row level security;

revoke all on public.availability_notices from anon, authenticated;
revoke all on public.availability_digests from anon, authenticated;

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

-- ---- 6. weekly availability ends ----------------------------------------------------
alter table public.availability add column if not exists repeat_until date;

alter table public.availability drop constraint if exists availability_repeat_until_weekly;
alter table public.availability add constraint availability_repeat_until_weekly
  check (repeat_until is null or weekday is not null);

commit;
