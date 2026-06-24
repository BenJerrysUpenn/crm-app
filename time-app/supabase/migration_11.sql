-- ============================================================================
-- Withers Time — migration 11
-- Run once in the Supabase SQL editor, after migration_10.sql.
-- Configurable grace periods (single-row settings table).
-- ============================================================================
create table if not exists public.app_settings (
  id smallint primary key default 1,
  employee_clockin_grace_min integer not null default 5,
  manager_clockin_grace_min integer not null default 15,
  tardy_grace_min integer not null default 15,
  shift_reminder_lead_min integer not null default 30,
  updated_at timestamptz not null default now(),
  constraint app_settings_single_row check (id = 1)
);

insert into public.app_settings (id) values (1) on conflict (id) do nothing;

alter table public.app_settings enable row level security;

drop policy if exists settings_select on public.app_settings;
create policy settings_select on public.app_settings for select to authenticated
  using (true);

drop policy if exists settings_manager on public.app_settings;
create policy settings_manager on public.app_settings for all to authenticated
  using (public.is_manager()) with check (public.is_manager());
