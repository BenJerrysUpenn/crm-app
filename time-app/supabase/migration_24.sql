-- ============================================================================
-- Withers Time — migration 24: store hours + in-store coverage
-- Run once in the Supabase SQL editor, after migration_22.sql. Safe to re-run.
--
-- Why: on 2026-09-20 a published week had a two-hour hole in the middle of a
-- trading day — nobody scheduled in the store while the door was open. The
-- schedule app had no idea when the store is open, so it could not catch it.
-- This migration teaches it, and "Publish week" then refuses to publish a week
-- with an uncovered opening hour unless the manager overrides.
--
-- Three pieces:
--   1. store_hours            — the weekly pattern. One row per weekday.
--   2. store_hours_exceptions — one-off dates (holidays, closures, special
--                               hours). An exception NEVER changes the weekly
--                               pattern: closing one date leaves the rest of
--                               the week exactly as it was.
--   3. shift_types.in_store   — which shift types actually put a person behind
--                               the counter. Catering, Marketing and Staff
--                               Meeting do not, so they cannot cover the store.
--
-- Holiday rule (owner's ruling): the store defaults to OPEN with its normal
-- weekday hours on holidays. A holiday only changes anything if somebody adds
-- an exception row for that date. There is no holiday calendar in the data.
--
-- No rows are seeded into store_hours on purpose. A weekday with no row means
-- "hours not set", which is deliberately different from "closed": the publish
-- check does not block on an unset day, it nags the manager to set the hours
-- on the Team page. Seeding would silently invent trading hours.
--
-- This migration is independent of migration_23 (unmerged) and can be applied
-- before or after it.
-- ============================================================================

-- ---------- store_hours: the weekly pattern ---------------------------------
-- weekday: 0 = Sunday … 6 = Saturday, matching JS Date#getDay so the app can
-- index it without a lookup table.
create table if not exists public.store_hours (
  weekday    smallint primary key check (weekday between 0 and 6),
  is_closed  boolean not null default false,
  opens      time,
  closes     time,
  updated_at timestamptz not null default now()
);

-- Named separately (rather than inline) so re-running this file can replace it.
alter table public.store_hours drop constraint if exists store_hours_window_ck;
alter table public.store_hours add constraint store_hours_window_ck
  check (is_closed or (opens is not null and closes is not null and opens < closes));

alter table public.store_hours enable row level security;

drop policy if exists store_hours_select on public.store_hours;
create policy store_hours_select on public.store_hours for select to authenticated
  using (true);

-- The (select public.is_manager()) wrapper is mandatory in this project: a bare
-- is_manager() is re-evaluated per row and has caused statement timeouts.
drop policy if exists store_hours_manager on public.store_hours;
create policy store_hours_manager on public.store_hours for all to authenticated
  using ((select public.is_manager())) with check ((select public.is_manager()));

-- ---------- store_hours_exceptions: one-off dates ---------------------------
-- One row per calendar date. is_closed defaults to true because the common case
-- is "we are shut that day"; set is_closed = false with opens/closes for a
-- short day or a late night.
create table if not exists public.store_hours_exceptions (
  date       date primary key,
  label      text,
  is_closed  boolean not null default true,
  opens      time,
  closes     time,
  created_at timestamptz not null default now()
);

alter table public.store_hours_exceptions drop constraint if exists store_hours_exceptions_window_ck;
alter table public.store_hours_exceptions add constraint store_hours_exceptions_window_ck
  check (is_closed or (opens is not null and closes is not null and opens < closes));

alter table public.store_hours_exceptions enable row level security;

drop policy if exists store_hours_exceptions_select on public.store_hours_exceptions;
create policy store_hours_exceptions_select on public.store_hours_exceptions for select to authenticated
  using (true);

drop policy if exists store_hours_exceptions_manager on public.store_hours_exceptions;
create policy store_hours_exceptions_manager on public.store_hours_exceptions for all to authenticated
  using ((select public.is_manager())) with check ((select public.is_manager()));

-- ---------- shift_types.in_store --------------------------------------------
-- Only an in-store shift counts towards covering the store's opening hours.
-- Default true: a new shift type is assumed to be counter work until someone
-- says otherwise, so an unclassified type can never silently create a hole.
--
-- The back-fill runs only when the column is being added. On a re-run we leave
-- the values alone — by then a manager may have reclassified a type on the Team
-- page, and this file must not quietly undo that.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shift_types'
      and column_name = 'in_store'
  ) then
    alter table public.shift_types add column in_store boolean not null default true;
    update public.shift_types
       set in_store = false
     where name in ('Catering', 'Marketing', 'Staff Meeting');
  end if;
end $$;
