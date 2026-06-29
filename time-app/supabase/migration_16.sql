-- ============================================================================
-- Withers Time — migration 16
-- Run once in the Supabase SQL editor, after migration_15.sql.
-- Schedule annotations (notes/banners on the schedule for a date range).
-- ============================================================================
create table if not exists public.annotations (
  id bigint generated always as identity primary key,
  title text not null,
  message text,
  start_date date not null,
  end_date date not null,
  color text not null default '#0ea5e9',
  business_closed boolean not null default false,
  no_time_off boolean not null default false,
  announcement boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists annotations_dates_idx on public.annotations (start_date, end_date);

alter table public.annotations enable row level security;

drop policy if exists annotations_select on public.annotations;
create policy annotations_select on public.annotations for select to authenticated
  using (true);
drop policy if exists annotations_manager on public.annotations;
create policy annotations_manager on public.annotations for all to authenticated
  using (public.is_manager()) with check (public.is_manager());
