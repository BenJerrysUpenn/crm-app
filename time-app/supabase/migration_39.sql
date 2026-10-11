-- ============================================================================
-- Withers Time, migration 39: the Metrics page's saved views and sales targets
-- Run once in the Supabase SQL editor, after migration_38.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_39_verify.sql. ROLLBACK. supabase/migration_39_down.sql.
--
-- WHY (Alina, 2026-10-10, bj-finance #671). finance.withers-ventures.com/metrics
-- is personal: each manager saves their own pages ("my finance view", "my
-- catering view") and swaps between them. A view is a named, ordered set of
-- metric widgets, each with its own settings (period, stream). Sales are
-- measured against monthly targets per stream from the seller-era seasonal
-- curve for a $600K year, and those targets are DATA, not code, because parts
-- of them are still being decided (concessions gross vs net, and whether the
-- year is rescaled after the PAX cut).
--
-- Until this is applied the page still works: views are kept in the browser
-- and the targets come from a copy of the seed below bundled with the page
-- (time-app/lib/metrics/salesTargetsSeed.ts; a unit test keeps the two equal).
--
-- WHAT THIS ADDS
--   1. metric_views: one row per saved view. widgets is the ordered list the
--      page renders, as JSON: [{"id": "...", "metric": "catering_ar",
--      "settings": {"period": "8w", "stream": "all"}}, ...]. The page
--      validates its shape (time-app/lib/metrics/views.ts); the database only
--      insists it is an array of at most 24 objects. Deleting a view on the
--      page ARCHIVES it (archived_at): rows are never deleted through the API,
--      the house rule for anything a person made.
--   2. metric_preferences: one row per person, which view they last had open.
--   3. sales_targets: the target per calendar month and stream ('in_store',
--      'catering', 'concessions'; 'delivery' and 'all' are allowed for later
--      use). The whole-business target for a month is the sum of its stream
--      rows, unless an 'all' row overrides it; nothing assumes a year total.
--      Seeded from the 3-stream $600K table (#671 frame of 2026-10-10,
--      rebuilt from the seller's separate Penn and Ventures books: seven
--      seller years, equal weights, concessions on our event calendar) for
--      every month of 2026 and 2027, with Alina's ruling of 2026-10-10:
--      December concessions (PAX) = $5,000, not $20,425. The year is not
--      rescaled after that cut (still open), so the seed sums to $584,575.
--      In-store covers delivery (the seller's Penn sales accounts).
--      measure says which basis a row is on, 'net' or 'gross'. Every seeded
--      row is 'net': the seller booked Aramark's net settlement, and gross vs
--      net for concessions is not ruled yet. The page measures concessions
--      sales on the same basis as the target row, so switching is an UPDATE
--      of measure and amount, no code change. Concessions rows are also
--      marked provisional = true until that ruling.
--
-- WHO MAY TOUCH IT.
--   metric_views, metric_preferences: a manager reads and writes only their
--   own rows (owner_id = auth.uid()); there is no DELETE policy and DELETE is
--   revoked, so archiving is the only way a view goes away. Policies use the
--   (select ...) wrapper this project requires, so is_manager() runs once per
--   statement, not once per row.
--   sales_targets: managers read; nobody writes through PostgREST. Targets are
--   changed in the SQL editor (or by a later admin page with the service role).
-- ============================================================================

begin;

-- ---------- metric_views ---------------------------------------------------------
create table if not exists public.metric_views (
  id          bigint generated always as identity primary key,
  owner_id    uuid        not null references public.profiles (id) on delete cascade,
  name        text        not null,
  -- Order among the owner's views, smallest first.
  position    integer     not null default 0,
  widgets     jsonb       not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);

alter table public.metric_views drop constraint if exists metric_views_name_check;
alter table public.metric_views add constraint metric_views_name_check
  check (char_length(btrim(name)) between 1 and 60);

alter table public.metric_views drop constraint if exists metric_views_widgets_check;
alter table public.metric_views add constraint metric_views_widgets_check
  check (jsonb_typeof(widgets) = 'array' and jsonb_array_length(widgets) <= 24);

-- One live view per name per person, case-insensitively. Archived views keep
-- their names out of the way.
create unique index if not exists metric_views_owner_name_live
  on public.metric_views (owner_id, lower(btrim(name))) where archived_at is null;
create index if not exists metric_views_owner_idx
  on public.metric_views (owner_id, position) where archived_at is null;

create or replace function public.touch_metric_view()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'A saved view cannot change owner.';
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists metric_views_touch on public.metric_views;
create trigger metric_views_touch before update on public.metric_views
  for each row execute function public.touch_metric_view();

alter table public.metric_views enable row level security;

drop policy if exists metric_views_own_select on public.metric_views;
create policy metric_views_own_select on public.metric_views for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_manager()));

drop policy if exists metric_views_own_insert on public.metric_views;
create policy metric_views_own_insert on public.metric_views for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select public.is_manager()));

drop policy if exists metric_views_own_update on public.metric_views;
create policy metric_views_own_update on public.metric_views for update to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_manager()))
  with check (owner_id = (select auth.uid()) and (select public.is_manager()));

revoke delete, truncate on public.metric_views from anon, authenticated;
revoke all on public.metric_views from anon;

-- ---------- metric_preferences -----------------------------------------------------
create table if not exists public.metric_preferences (
  owner_id       uuid        primary key references public.profiles (id) on delete cascade,
  active_view_id bigint      references public.metric_views (id) on delete set null,
  updated_at     timestamptz not null default now()
);

alter table public.metric_preferences enable row level security;

drop policy if exists metric_preferences_own_select on public.metric_preferences;
create policy metric_preferences_own_select on public.metric_preferences for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_manager()));

drop policy if exists metric_preferences_own_insert on public.metric_preferences;
create policy metric_preferences_own_insert on public.metric_preferences for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select public.is_manager()));

drop policy if exists metric_preferences_own_update on public.metric_preferences;
create policy metric_preferences_own_update on public.metric_preferences for update to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_manager()))
  with check (owner_id = (select auth.uid()) and (select public.is_manager()));

revoke delete, truncate on public.metric_preferences from anon, authenticated;
revoke all on public.metric_preferences from anon;

-- The view a preference points at must be the same person's.
create or replace function public.guard_metric_preference()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.active_view_id is not null and not exists (
    select 1 from public.metric_views v where v.id = new.active_view_id and v.owner_id = new.owner_id
  ) then
    raise exception 'View % is not one of this person''s views.', new.active_view_id;
  end if;
  new.updated_at := now();
  return new;
end
$$;

revoke execute on function public.guard_metric_preference() from public, anon, authenticated;

drop trigger if exists metric_preferences_guard on public.metric_preferences;
create trigger metric_preferences_guard before insert or update on public.metric_preferences
  for each row execute function public.guard_metric_preference();

-- ---------- sales_targets ----------------------------------------------------------
create table if not exists public.sales_targets (
  -- The first day of the calendar month.
  month      date          not null,
  stream     text          not null,
  -- Net sales, before tax, in dollars.
  amount     numeric(12,2) not null,
  -- How the number was arrived at, for the person reading it later.
  basis      text          not null,
  -- Not yet ruled on: the page labels it "provisional".
  provisional boolean      not null default false,
  -- 'net' or 'gross': the basis the stream's sales are measured on against
  -- this row (concessions: Aramark's net settlement, or register gross).
  measure    text          not null default 'net',
  updated_at timestamptz   not null default now(),
  primary key (month, stream)
);

alter table public.sales_targets drop constraint if exists sales_targets_month_check;
alter table public.sales_targets add constraint sales_targets_month_check
  check (extract(day from month) = 1);

alter table public.sales_targets drop constraint if exists sales_targets_stream_check;
alter table public.sales_targets add constraint sales_targets_stream_check
  check (stream in ('all', 'in_store', 'delivery', 'catering', 'concessions'));

alter table public.sales_targets drop constraint if exists sales_targets_measure_check;
alter table public.sales_targets add constraint sales_targets_measure_check
  check (measure in ('net', 'gross'));

alter table public.sales_targets drop constraint if exists sales_targets_amount_check;
alter table public.sales_targets add constraint sales_targets_amount_check
  check (amount >= 0);

alter table public.sales_targets enable row level security;

drop policy if exists sales_targets_manager_select on public.sales_targets;
create policy sales_targets_manager_select on public.sales_targets for select to authenticated
  using ((select public.is_manager()));

revoke insert, update, delete, truncate on public.sales_targets from anon, authenticated;
revoke all on public.sales_targets from anon;

-- The targets by month and stream (#671, 2026-10-10, 3-stream table, with
-- December concessions set to $5,000 by Alina's ruling). Each stream's twelve
-- months: in-store $397,730, catering $114,956, concessions $71,889;
-- together $584,575.
insert into public.sales_targets (month, stream, amount, basis, provisional)
select make_date(yrs.y, c.m, 1), c.stream, c.amt,
       case when c.stream = 'concessions'
            then '$600K table, seller-era share on our event calendar, net of Aramark; Dec PAX $5,000 (ruled 2026-10-10); PROVISIONAL: gross vs net not ruled; bj-finance #671'
            else '$600K year x seller-era share (Penn + Ventures books, 2017-19, 2022-25, equal weights); bj-finance #671' end,
       c.stream = 'concessions'
  from (values
          ('in_store',  1, 16823.00), ('in_store',  2, 23939.00), ('in_store',  3, 31672.00),
          ('in_store',  4, 46064.00), ('in_store',  5, 44393.00), ('in_store',  6, 45755.00),
          ('in_store',  7, 46811.00), ('in_store',  8, 39784.00), ('in_store',  9, 36226.00),
          ('in_store', 10, 28870.00), ('in_store', 11, 20995.00), ('in_store', 12, 16398.00),
          ('catering',  1,  1156.00), ('catering',  2,  1559.00), ('catering',  3,  2220.00),
          ('catering',  4, 12085.00), ('catering',  5, 17520.00), ('catering',  6, 19724.00),
          ('catering',  7, 17224.00), ('catering',  8, 19000.00), ('catering',  9, 12111.00),
          ('catering', 10,  5309.00), ('catering', 11,  3206.00), ('catering', 12,  3842.00),
          ('concessions',  1, 17892.00), ('concessions',  2,     0.00), ('concessions',  3, 36132.00),
          ('concessions',  4,   479.00), ('concessions',  5,  2542.00), ('concessions',  6,  2507.00),
          ('concessions',  7,  1521.00), ('concessions',  8,   451.00), ('concessions',  9,  5354.00),
          ('concessions', 10,    11.00), ('concessions', 11,     0.00), ('concessions', 12,  5000.00)
       ) as c (stream, m, amt)
  cross join (values (2026), (2027)) as yrs (y)
on conflict (month, stream) do nothing;

commit;
