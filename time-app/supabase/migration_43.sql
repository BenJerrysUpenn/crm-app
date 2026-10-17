-- ============================================================================
-- Withers Time, migration 43: the control board's dated settings and salaries
-- Run once in the Supabase SQL editor, after migration_42.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_43_verify.sql. ROLLBACK. supabase/migration_43_down.sql.
--
-- APPLY ORDER. Either order is safe; the house order is deploy first, then
-- run this file.
--   * New code, old database: the Targets tab says it needs migration 43 and
--     saves nothing (503); the Team page's Salary column says "not set up".
--     Every other page works as before.
--   * Old code, new database: nothing reads or writes these tables yet.
--   It needs migration 42 (public.is_owner()) in place either way.
--
-- WHY (bj-finance #693, lane #692 Labor targets). The Targets tab on the
-- finance site is the control board for the business: the targets it runs to
-- (COGS, payroll and prime cost as shares of sales), the sales estimate they
-- are shares of, and the rates they are built from (employer taxes, workers'
-- comp, the catering premium, the solo-close bonus). Alina, 2026-10-14: the
-- board is the single source for targets and rates; code reads them from
-- here instead of keeping its own copies (bj-finance payroll will, later).
-- app_settings is one fixed row with no history, so this adds a store where
-- every value is dated.
--
-- SCHEMA ONLY. This repo is public: no values are written here, and none may
-- be. Owners enter every value on the board (and salaries on the Team page)
-- after this is applied.
--
-- WHAT THIS ADDS
--   control_settings: one row per value as it was set. A change is a NEW row,
--     never an edit, so the table is the history.
--       key             which setting, e.g. 'target.payroll_pct' (the list and
--                       each key's units: time-app/lib/controlBoard/settings.ts
--                       and the README). Not a fixed list here: a new board
--                       category is new keys, not a migration.
--       value           the setting's main number, in the key's unit
--                       (shares are fractions: 0.25 is 25%).
--       detail          the key's other parts as a JSON object, e.g. a tax's
--                       {"wage_cap": ...}; '{}' when it has none.
--       effective_from  the as-of date: the value is in force from this day
--                       until a later effective_from for the same key.
--       review_by       when to look at it again (the board's chip).
--       source          where the value came from; method, how it was worked
--                       out. Kept so it can be redone next year.
--       recorded_by, recorded_at  who entered it and when, stamped here.
--   profile_salaries: the same, for a salaried person's annual salary
--     (profile_id instead of key; annual_salary instead of value).
--
--   THE VALUE IN FORCE on a day is the row with the latest effective_from on
--   or before that day; two rows with the same effective_from (a same-day
--   correction) resolve to the later recorded_at, then the higher id.
--   control_settings_on(day) and profile_salaries_on(day) return exactly
--   that, one row per key or person, for any reader: the app, and bj-finance
--   from the Mac over its own connection.
--
-- WHO MAY TOUCH IT. Managers read (an owner is a manager, migration 42).
-- Only an owner adds a row. Nobody changes or removes a row through the API:
-- UPDATE, DELETE and TRUNCATE are not granted, so history cannot be rewritten
-- from the app. The SQL editor and the service role are not limited.
-- (select public.is_manager()) and (select public.is_owner()) are wrapped in
-- scalar subqueries so they run once per statement, not once per row.
-- ============================================================================

begin;

-- ---- control_settings -------------------------------------------------------------

create table if not exists public.control_settings (
  id             bigint generated always as identity primary key,
  key            text        not null,
  value          numeric     not null,
  detail         jsonb       not null default '{}'::jsonb,
  effective_from date        not null,
  review_by      date        not null,
  source         text        not null,
  method         text,
  recorded_by    uuid        references public.profiles (id) on delete set null,
  recorded_at    timestamptz not null default now()
);

alter table public.control_settings drop constraint if exists control_settings_key_check;
alter table public.control_settings add constraint control_settings_key_check
  check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and char_length(key) <= 80);

alter table public.control_settings drop constraint if exists control_settings_value_check;
alter table public.control_settings add constraint control_settings_value_check
  check (value <> 'NaN'::numeric and value <> 'Infinity'::numeric and value <> '-Infinity'::numeric);

alter table public.control_settings drop constraint if exists control_settings_detail_check;
alter table public.control_settings add constraint control_settings_detail_check
  check (jsonb_typeof(detail) = 'object');

alter table public.control_settings drop constraint if exists control_settings_source_check;
alter table public.control_settings add constraint control_settings_source_check
  check (char_length(btrim(source)) between 1 and 2000);

alter table public.control_settings drop constraint if exists control_settings_method_check;
alter table public.control_settings add constraint control_settings_method_check
  check (method is null or char_length(method) <= 2000);

create index if not exists control_settings_key_idx
  on public.control_settings (key, effective_from desc, recorded_at desc, id desc);

-- ---- profile_salaries -------------------------------------------------------------

create table if not exists public.profile_salaries (
  id             bigint        generated always as identity primary key,
  profile_id     uuid          not null references public.profiles (id) on delete cascade,
  annual_salary  numeric(12,2) not null,
  effective_from date          not null,
  review_by      date          not null,
  source         text          not null,
  method         text,
  recorded_by    uuid          references public.profiles (id) on delete set null,
  recorded_at    timestamptz   not null default now()
);

alter table public.profile_salaries drop constraint if exists profile_salaries_amount_check;
alter table public.profile_salaries add constraint profile_salaries_amount_check
  check (annual_salary >= 0);

alter table public.profile_salaries drop constraint if exists profile_salaries_source_check;
alter table public.profile_salaries add constraint profile_salaries_source_check
  check (char_length(btrim(source)) between 1 and 2000);

alter table public.profile_salaries drop constraint if exists profile_salaries_method_check;
alter table public.profile_salaries add constraint profile_salaries_method_check
  check (method is null or char_length(method) <= 2000);

create index if not exists profile_salaries_profile_idx
  on public.profile_salaries (profile_id, effective_from desc, recorded_at desc, id desc);

-- ---- who recorded it, and when, is the database's word ---------------------------
-- Through the API (role authenticated) the row is stamped with the caller and
-- the database clock, whatever the request sent. The SQL editor and the
-- service role may name who it was for (e.g. a back-filled history).
create or replace function public.stamp_control_row()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.recorded_at := now();
  if current_user = 'authenticated' then
    new.recorded_by := auth.uid();
  end if;
  return new;
end
$$;

-- Trigger-only.
revoke execute on function public.stamp_control_row() from public, anon, authenticated, service_role;

drop trigger if exists control_settings_stamp on public.control_settings;
create trigger control_settings_stamp before insert on public.control_settings
  for each row execute function public.stamp_control_row();

drop trigger if exists profile_salaries_stamp on public.profile_salaries;
create trigger profile_salaries_stamp before insert on public.profile_salaries
  for each row execute function public.stamp_control_row();

-- ---- the value in force on a day -------------------------------------------------
-- SECURITY INVOKER: an API caller sees only what the policies below let them
-- read; the Mac's own connection reads everything.
create or replace function public.control_settings_on(p_day date)
returns setof public.control_settings
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (key) *
    from public.control_settings
   where effective_from <= p_day
   order by key, effective_from desc, recorded_at desc, id desc;
$$;

create or replace function public.profile_salaries_on(p_day date)
returns setof public.profile_salaries
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (profile_id) *
    from public.profile_salaries
   where effective_from <= p_day
   order by profile_id, effective_from desc, recorded_at desc, id desc;
$$;

revoke execute on function public.control_settings_on(date) from public, anon;
revoke execute on function public.profile_salaries_on(date) from public, anon;
grant execute on function public.control_settings_on(date) to authenticated, service_role;
grant execute on function public.profile_salaries_on(date) to authenticated, service_role;

-- ---- who reads, who adds ----------------------------------------------------------

alter table public.control_settings enable row level security;
alter table public.profile_salaries enable row level security;

drop policy if exists control_settings_manager_select on public.control_settings;
create policy control_settings_manager_select on public.control_settings for select to authenticated
  using ((select public.is_manager()));

drop policy if exists control_settings_owner_insert on public.control_settings;
create policy control_settings_owner_insert on public.control_settings for insert to authenticated
  with check ((select public.is_owner()));

drop policy if exists profile_salaries_manager_select on public.profile_salaries;
create policy profile_salaries_manager_select on public.profile_salaries for select to authenticated
  using ((select public.is_manager()));

drop policy if exists profile_salaries_owner_insert on public.profile_salaries;
create policy profile_salaries_owner_insert on public.profile_salaries for insert to authenticated
  with check ((select public.is_owner()));

revoke all on public.control_settings from anon;
revoke all on public.profile_salaries from anon;
revoke update, delete, truncate on public.control_settings from authenticated;
revoke update, delete, truncate on public.profile_salaries from authenticated;
grant select, insert on public.control_settings to authenticated;
grant select, insert on public.profile_salaries to authenticated;

commit;
