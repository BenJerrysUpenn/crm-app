-- ============================================================================
-- Withers Time — schedule + geo time clock schema
-- Run this once in the Supabase SQL editor (same project as the CRM).
-- ============================================================================

-- ---------- profiles ---------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  phone text,
  role text not null default 'employee' check (role in ('manager','employee')),
  hourly_rate numeric,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Auto-create a profile row when a new auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper: is the current user a manager? SECURITY DEFINER avoids recursive RLS.
create or replace function public.is_manager()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'manager'
  );
$$;

-- ---------- locations (geofences) -------------------------------------------
create table if not exists public.locations (
  id bigint generated always as identity primary key,
  name text not null,
  latitude double precision not null,
  longitude double precision not null,
  radius_meters integer not null default 150,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- shifts -----------------------------------------------------------
create table if not exists public.shifts (
  id bigint generated always as identity primary key,
  employee_id uuid not null references public.profiles (id) on delete cascade,
  location_id bigint references public.locations (id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  position text,
  notes text,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shifts_employee_idx on public.shifts (employee_id);
create index if not exists shifts_starts_idx on public.shifts (starts_at);

-- ---------- time_entries -----------------------------------------------------
create table if not exists public.time_entries (
  id bigint generated always as identity primary key,
  employee_id uuid not null references public.profiles (id) on delete cascade,
  shift_id bigint references public.shifts (id) on delete set null,
  location_id bigint references public.locations (id) on delete set null,
  clock_in_at timestamptz not null default now(),
  clock_in_lat double precision,
  clock_in_lng double precision,
  clock_in_accuracy_m double precision,
  clock_in_distance_m double precision,
  clock_out_at timestamptz,
  clock_out_lat double precision,
  clock_out_lng double precision,
  clock_out_distance_m double precision,
  status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now()
);
create index if not exists time_entries_employee_idx on public.time_entries (employee_id);
create index if not exists time_entries_in_idx on public.time_entries (clock_in_at);
-- One open entry per employee at a time.
create unique index if not exists time_entries_one_open
  on public.time_entries (employee_id) where (status = 'open');

-- ---------- notifications ----------------------------------------------------
create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  sent_email boolean not null default false,
  sent_sms boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.profiles      enable row level security;
alter table public.locations     enable row level security;
alter table public.shifts        enable row level security;
alter table public.time_entries  enable row level security;
alter table public.notifications enable row level security;

-- profiles: read own + managers read all; update own (not role) ; managers manage all
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_manager());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_manager_all on public.profiles;
create policy profiles_manager_all on public.profiles for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- locations: everyone authenticated reads; managers write
drop policy if exists locations_select on public.locations;
create policy locations_select on public.locations for select to authenticated
  using (true);
drop policy if exists locations_manager_all on public.locations;
create policy locations_manager_all on public.locations for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- shifts: employees read own published shifts; managers full
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts for select to authenticated
  using ((employee_id = auth.uid() and published) or public.is_manager());
drop policy if exists shifts_manager_all on public.shifts;
create policy shifts_manager_all on public.shifts for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- time_entries: employees read/insert/update own; managers full
drop policy if exists time_select on public.time_entries;
create policy time_select on public.time_entries for select to authenticated
  using (employee_id = auth.uid() or public.is_manager());
drop policy if exists time_insert on public.time_entries;
create policy time_insert on public.time_entries for insert to authenticated
  with check (employee_id = auth.uid() or public.is_manager());
drop policy if exists time_update on public.time_entries;
create policy time_update on public.time_entries for update to authenticated
  using (employee_id = auth.uid() or public.is_manager())
  with check (employee_id = auth.uid() or public.is_manager());

-- notifications: read/update own; managers read all
drop policy if exists notif_select on public.notifications;
create policy notif_select on public.notifications for select to authenticated
  using (user_id = auth.uid() or public.is_manager());
drop policy if exists notif_update on public.notifications;
create policy notif_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
-- Seed: backfill profiles for existing auth users, and a default location.
-- Edit the lat/lng/radius to your store, or do it later in the app's Team page.
-- ============================================================================
insert into public.profiles (id, full_name)
select u.id, coalesce(u.raw_user_meta_data ->> 'full_name', u.email)
from auth.users u
on conflict (id) do nothing;

insert into public.locations (name, latitude, longitude, radius_meters, is_default)
select 'Ben & Jer''s UPenn', 39.9522, -75.1932, 150, true
where not exists (select 1 from public.locations);

-- Make yourself a manager (replace with your email):
-- update public.profiles set role = 'manager'
-- where id = (select id from auth.users where email = 'you@withers-ventures.com');

-- ============================================================================
-- availability (added) — employees report when they can / can't work.
-- Either weekday (0=Sun..6=Sat) for a recurring window, OR specific_date for a
-- one-off (e.g. time off). is_available=false means "can't work then".
-- ============================================================================
create table if not exists public.availability (
  id bigint generated always as identity primary key,
  employee_id uuid not null references public.profiles (id) on delete cascade,
  weekday smallint check (weekday between 0 and 6),
  specific_date date,
  start_time time,
  end_time time,
  is_available boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  constraint availability_when check (weekday is not null or specific_date is not null)
);
create index if not exists availability_employee_idx on public.availability (employee_id);

alter table public.availability enable row level security;

drop policy if exists avail_select on public.availability;
create policy avail_select on public.availability for select to authenticated
  using (employee_id = auth.uid() or public.is_manager());
drop policy if exists avail_own on public.availability;
create policy avail_own on public.availability for all to authenticated
  using (employee_id = auth.uid()) with check (employee_id = auth.uid());
drop policy if exists avail_manager on public.availability;
create policy avail_manager on public.availability for all to authenticated
  using (public.is_manager()) with check (public.is_manager());
