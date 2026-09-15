-- ============================================================================
-- Withers Time — migration 23: staffing forms (onboarding, payroll setup,
-- offboarding). Run once in the Supabase SQL editor, after migration_22.sql.
-- Safe to re-run.
--
-- A manager fills one of three forms on /staffing. Each submission is a
-- staff_lifecycle record with an ordered list of steps. Steps are either
-- automatic (the app does them: Withers-time invite, fob assignment, auth
-- ban, role/active changes) or manual (Square, Slack, QuickBooks Workforce,
-- Google Group), and a manual step is a checklist line with the per-person
-- link and a Mark done button that records who and when.
--
-- Nothing here deletes a profile or an auth user, ever. time_entries has
-- ON DELETE CASCADE from profiles, so deleting a person destroys their
-- payroll hours. Offboarding bans the auth user and revokes sessions instead.
-- ============================================================================

begin;

-- ---------- profiles: the few per-person facts the forms maintain ---------
alter table public.profiles
  add column if not exists preferred_name text,
  add column if not exists start_date date,
  add column if not exists last_day date,
  add column if not exists has_workforce boolean not null default false,
  add column if not exists qbo_employee_id text;

comment on column public.profiles.has_workforce is
  'True once the person has finished QuickBooks Workforce self-setup (SSN, DOB, address, bank). Until then they are not payable.';

-- ---------- staff_lifecycle: one row per form submission -------------------
create table if not exists public.staff_lifecycle (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('onboarding', 'payroll_setup', 'offboarding')),
  -- Null until the Withers-time profile exists (an onboarding whose invite
  -- failed). Set null, never cascade: the record outlives the person.
  employee_id uuid references public.profiles (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  -- The submitted fields, as typed. Never holds SSN, DOB, address or bank
  -- details; those go straight into Workforce by the employee.
  form jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists staff_lifecycle_employee_idx
  on public.staff_lifecycle (employee_id);
create index if not exists staff_lifecycle_status_idx
  on public.staff_lifecycle (status, created_at desc);

-- ---------- staff_lifecycle_steps: the ordered checklist per record --------
create table if not exists public.staff_lifecycle_steps (
  id bigint generated always as identity primary key,
  lifecycle_id bigint not null references public.staff_lifecycle (id) on delete cascade,
  key text not null,
  seq integer not null,
  mode text not null check (mode in ('auto', 'manual')),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed', 'skipped')),
  label text not null,
  -- {"lines": [...], "link": "...", "recipient": "...", "reason": "..."}
  detail jsonb not null default '{}'::jsonb,
  -- What happened (auto) or the manager's note (manual).
  result text,
  completed_by uuid references public.profiles (id) on delete set null,
  completed_at timestamptz,
  unique (lifecycle_id, key)
);
create index if not exists staff_lifecycle_steps_lifecycle_idx
  on public.staff_lifecycle_steps (lifecycle_id, seq);

-- ---------- updated_at ------------------------------------------------------
create or replace function public.staff_lifecycle_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists staff_lifecycle_touch on public.staff_lifecycle;
create trigger staff_lifecycle_touch
  before update on public.staff_lifecycle
  for each row execute function public.staff_lifecycle_touch();

-- ---------- revoke_user_sessions --------------------------------------------
-- Offboarding step 2. Banning the auth user stops new logins and makes the
-- server reject the person's token on the next request; this removes the
-- sessions and refresh tokens as well so nothing lingers. SECURITY DEFINER
-- because auth.* is not reachable from the service role through PostgREST.
-- Only the service role may call it (revoked from everyone else below).
create or replace function public.revoke_user_sessions(uid uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  n integer;
begin
  delete from auth.refresh_tokens where user_id = uid::text;
  delete from auth.sessions where user_id = uid;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.revoke_user_sessions(uuid) from public;
revoke all on function public.revoke_user_sessions(uuid) from anon;
revoke all on function public.revoke_user_sessions(uuid) from authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;

-- ---------- Row level security ---------------------------------------------
-- Managers only, on both tables. The route handlers use the service role for
-- writes after their own manager check; these policies cover the page's
-- server-side reads and any direct client access. is_manager() is wrapped in
-- a scalar subquery so it runs once per statement, not once per row.
alter table public.staff_lifecycle enable row level security;
alter table public.staff_lifecycle_steps enable row level security;

drop policy if exists staff_lifecycle_manager_all on public.staff_lifecycle;
create policy staff_lifecycle_manager_all on public.staff_lifecycle
  for all to authenticated
  using ((select public.is_manager()))
  with check ((select public.is_manager()));

drop policy if exists staff_lifecycle_steps_manager_all on public.staff_lifecycle_steps;
create policy staff_lifecycle_steps_manager_all on public.staff_lifecycle_steps
  for all to authenticated
  using ((select public.is_manager()))
  with check ((select public.is_manager()));

commit;
