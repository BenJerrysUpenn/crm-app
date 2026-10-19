-- ============================================================================
-- Withers Time, migration 47: Labor Hours Planning inputs
-- Run once in the Supabase SQL editor, after migration_46.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_47_verify.sql. ROLLBACK. supabase/migration_47_down.sql.
--
-- WHY (bj-finance #742, lane #692 Labor targets). The Labor Hours Planning
-- card plots target labor hours for each week ahead from last year's sales.
-- It needs three things the database does not hold yet:
--
--   store_hours_seasons     the store's opening hours as effective-dated
--                           seasons (winter, summer). Every reader of
--                           store_hours (the schedule's coverage check, the
--                           coverage reminder, payroll verify, the Team page)
--                           reads the season in force on the date
--                           (storeHoursFor in lib/coverage.ts). With no rows
--                           here nothing changes: store_hours is the standing
--                           pattern, in force before the first season.
--   concession_events       events at outside venues (convention shows): name,
--                           first and last day, expected net sales. The card
--                           spreads the sales evenly over the event's days.
--   catering_hours_history  last year's RAW catering shift hours by day, from
--                           the When I Work archive (scheduled hours,
--                           Position "Catering"). kind = 'marketing' marks a
--                           day whose Catering shifts were a marketing event
--                           (the archive has no other marker). Written once by
--                           bj-finance's loader on the Mac; after the
--                           archive's last day the card reads the time app's
--                           own shifts. The card takes concession event days
--                           and marketing days out as it reads, so an edited
--                           event counts at once.
--
-- Events are board values: each row is a dated revision with an as-of date
-- (effective_from), a review-by date, where it came from and how it was
-- worked out. An event is identified by event_key; the revision in force is
-- the one with the latest effective_from on or before the day (then the
-- latest recorded_at, then the highest id), as for control_settings. A
-- revision with cancelled = true takes an event off.
--
-- SCHEMA ONLY. This repo is public: no hours, sales, dates of events or
-- other business figures are written here, and none may be.
--
-- WHO MAY WRITE
--   store_hours_seasons: owners, from the Targets tab, like the other
--     planning inputs (owner ruling 2026-10-19). Everyone signed in reads
--     it, as they read store_hours. Managers keep the weekly hours and the
--     closed days (store_hours, store_hours_exceptions, migration 24).
--   concession_events: owners add revisions (as they add
--     control_settings, migration 43); managers read. Nobody changes or
--     removes a revision through the API: a correction is a new revision.
--   catering_hours_history: the Mac writes over its own database
--     connection; managers read; nobody writes through the API.
--
-- DEPLOY ORDER. Run this file before the app that reads it. Until it runs
-- the readers treat the missing tables as "no seasons, no events, no
-- history": the store-hours readers behave as before, and the card shows
-- its estimate as not available.
-- ============================================================================

begin;

-- ---- store_hours_seasons --------------------------------------------------------------

create table if not exists public.store_hours_seasons (
  effective_from date        not null,
  weekday        smallint    not null check (weekday between 0 and 6),
  name           text        not null,
  is_closed      boolean     not null default false,
  opens          time,
  closes         time,
  review_by      date,
  source         text,
  method         text,
  recorded_by    uuid        references public.profiles (id) on delete set null,
  updated_at     timestamptz not null default now(),
  primary key (effective_from, weekday)
);

alter table public.store_hours_seasons drop constraint if exists store_hours_seasons_window_ck;
alter table public.store_hours_seasons add constraint store_hours_seasons_window_ck
  check (is_closed or (opens is not null and closes is not null and opens < closes));

alter table public.store_hours_seasons drop constraint if exists store_hours_seasons_name_ck;
alter table public.store_hours_seasons add constraint store_hours_seasons_name_ck
  check (char_length(btrim(name)) between 1 and 80);

alter table public.store_hours_seasons drop constraint if exists store_hours_seasons_notes_ck;
alter table public.store_hours_seasons add constraint store_hours_seasons_notes_ck
  check ((source is null or char_length(source) <= 2000) and (method is null or char_length(method) <= 2000));

create or replace function public.stamp_store_hours_season()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  if current_user = 'authenticated' then
    new.recorded_by := auth.uid();
  end if;
  return new;
end
$$;

revoke execute on function public.stamp_store_hours_season() from public, anon, authenticated, service_role;

drop trigger if exists store_hours_seasons_stamp on public.store_hours_seasons;
create trigger store_hours_seasons_stamp before insert or update on public.store_hours_seasons
  for each row execute function public.stamp_store_hours_season();

alter table public.store_hours_seasons enable row level security;

drop policy if exists store_hours_seasons_select on public.store_hours_seasons;
create policy store_hours_seasons_select on public.store_hours_seasons for select to authenticated
  using (true);

drop policy if exists store_hours_seasons_manager on public.store_hours_seasons;
drop policy if exists store_hours_seasons_owner on public.store_hours_seasons;
create policy store_hours_seasons_owner on public.store_hours_seasons for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

revoke all on public.store_hours_seasons from anon;

-- ---- concession_events ------------------------------------------------------------------

create table if not exists public.concession_events (
  id                 bigint        generated always as identity primary key,
  event_key          text          not null,
  name               text          not null,
  start_date         date          not null,
  end_date           date          not null,
  expected_net_sales numeric(12,2) not null,
  provisional        boolean       not null default false,
  cancelled          boolean       not null default false,
  effective_from     date          not null,
  review_by          date          not null,
  source             text          not null,
  method             text,
  recorded_by        uuid          references public.profiles (id) on delete set null,
  recorded_at        timestamptz   not null default now()
);

alter table public.concession_events drop constraint if exists concession_events_key_ck;
alter table public.concession_events add constraint concession_events_key_ck
  check (event_key ~ '^[a-z0-9][a-z0-9_-]*$' and char_length(event_key) <= 80);

alter table public.concession_events drop constraint if exists concession_events_name_ck;
alter table public.concession_events add constraint concession_events_name_ck
  check (char_length(btrim(name)) between 1 and 120);

alter table public.concession_events drop constraint if exists concession_events_dates_ck;
alter table public.concession_events add constraint concession_events_dates_ck
  check (start_date <= end_date and effective_from <= review_by);

alter table public.concession_events drop constraint if exists concession_events_sales_ck;
alter table public.concession_events add constraint concession_events_sales_ck
  check (expected_net_sales >= 0);

alter table public.concession_events drop constraint if exists concession_events_notes_ck;
alter table public.concession_events add constraint concession_events_notes_ck
  check (char_length(btrim(source)) between 1 and 2000 and (method is null or char_length(method) <= 2000));

create index if not exists concession_events_key_idx
  on public.concession_events (event_key, effective_from desc, recorded_at desc, id desc);

drop trigger if exists concession_events_stamp on public.concession_events;
create trigger concession_events_stamp before insert on public.concession_events
  for each row execute function public.stamp_control_row();

-- ---- who reads and adds events ----------------------------------------------------------

alter table public.concession_events enable row level security;

drop policy if exists concession_events_manager_select on public.concession_events;
create policy concession_events_manager_select on public.concession_events for select to authenticated
  using ((select public.is_manager()));

drop policy if exists concession_events_owner_insert on public.concession_events;
create policy concession_events_owner_insert on public.concession_events for insert to authenticated
  with check ((select public.is_owner()));

revoke all on public.concession_events from anon;
revoke update, delete, truncate on public.concession_events from authenticated;
grant select, insert on public.concession_events to authenticated;

-- ---- catering_hours_history ---------------------------------------------------------------

create table if not exists public.catering_hours_history (
  day             date         primary key,
  hours           numeric(8,2) not null,
  shifts          integer      not null,
  kind            text         not null default 'catering',
  source          text         not null,
  built_by        text         not null,
  updated_at      timestamptz  not null default now()
);

alter table public.catering_hours_history drop constraint if exists catering_hours_history_source_ck;
alter table public.catering_hours_history add constraint catering_hours_history_source_ck
  check (source in ('when_i_work'));

alter table public.catering_hours_history drop constraint if exists catering_hours_history_kind_ck;
alter table public.catering_hours_history add constraint catering_hours_history_kind_ck
  check (kind in ('catering', 'marketing'));

alter table public.catering_hours_history drop constraint if exists catering_hours_history_hours_ck;
alter table public.catering_hours_history add constraint catering_hours_history_hours_ck
  check (hours >= 0 and shifts >= 0);

create or replace function public.touch_catering_hours_history()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

revoke execute on function public.touch_catering_hours_history() from public, anon, authenticated, service_role;

drop trigger if exists catering_hours_history_touch on public.catering_hours_history;
create trigger catering_hours_history_touch before insert or update on public.catering_hours_history
  for each row execute function public.touch_catering_hours_history();

alter table public.catering_hours_history enable row level security;

drop policy if exists catering_hours_history_manager_select on public.catering_hours_history;
create policy catering_hours_history_manager_select on public.catering_hours_history for select to authenticated
  using ((select public.is_manager()));

revoke insert, update, delete, truncate on public.catering_hours_history from anon, authenticated;
revoke all on public.catering_hours_history from anon;

commit;
