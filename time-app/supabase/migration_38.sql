-- ============================================================================
-- Withers Time, migration 38: one shift summary a day, at 8pm
-- Run once in the Supabase SQL editor, after migration_37.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_38_verify.sql. ROLLBACK. supabase/migration_38_down.sql.
--
-- WHY (Alina, 2026-10-08). Every shift save emailed and texted the person on
-- it, so a manager building the week sent one email and one text per edit.
-- Staff now get one summary a day at 8pm New York time, and everything waits
-- for it, edits to a shift starting within the next day included.
--
-- WHAT THIS ADDS
--   1. shift_notices: the queue. Each save of an assigned shift adds a row
--      (the shift, the person told, 'posted' or 'changed'); lib/shiftNotice.ts
--      writes it with the service-role key. A row goes when the shift is
--      deleted (ON DELETE CASCADE) or when the 8pm summary takes it.
--   2. shift_digests: one row per person per New York day a summary was
--      claimed for. The primary key is what makes it once a day.
--   3. claim_shift_digests(p_day): called by the missed-clock-in cron on every
--      tick from 20:00 New York time (lib/shiftNotice.ts decides the day). For
--      each person with queued notices and no summary yet for p_day, it
--      records the summary and takes their notices off the queue, returning
--      them; the cron then reads each shift as it stands and sends. Anyone
--      already summarised that day keeps what was queued since for the next.
--      Rows older than 60 days are pruned from shift_digests as it goes.
--
-- ONCE, EVEN WHEN TICKS OVERLAP. The insert into shift_digests and the delete
-- from shift_notices are one statement. A second caller claiming the same
-- person and day at the same moment waits on the first one's primary-key
-- entry, then ON CONFLICT DO NOTHING leaves that person out of its result, so
-- it deletes and returns nothing for them. A save that lands while a claim
-- runs is either in that claim's snapshot (and in tonight's summary) or stays
-- queued for tomorrow's. If the send fails after the claim, that summary is
-- not retried: notifications here are best-effort, as they always were.
--
-- WHO MAY TOUCH IT. The service role alone. RLS is on and there are no
-- policies, so no signed-in user reads or writes either table; anon and
-- authenticated also lose the table privileges and execute on the function.
-- ============================================================================

begin;

create table if not exists public.shift_notices (
  id          bigint generated always as identity primary key,
  shift_id    bigint      not null references public.shifts (id) on delete cascade,
  employee_id uuid        not null references public.profiles (id) on delete cascade,
  notice      text        not null,
  queued_at   timestamptz not null default now()
);

alter table public.shift_notices drop constraint if exists shift_notices_notice_check;
alter table public.shift_notices add constraint shift_notices_notice_check
  check (notice in ('posted', 'changed'));

create index if not exists shift_notices_employee_idx on public.shift_notices (employee_id);
create index if not exists shift_notices_shift_idx on public.shift_notices (shift_id);

create table if not exists public.shift_digests (
  employee_id uuid        not null references public.profiles (id) on delete cascade,
  -- The New York day whose 8pm summary this was.
  digest_day  date        not null,
  claimed_at  timestamptz not null default now(),
  primary key (employee_id, digest_day)
);

alter table public.shift_notices enable row level security;
alter table public.shift_digests enable row level security;

revoke all on public.shift_notices from anon, authenticated;
revoke all on public.shift_digests from anon, authenticated;

create or replace function public.claim_shift_digests(p_day date)
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
