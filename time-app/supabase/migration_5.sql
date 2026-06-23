-- ============================================================================
-- Withers Time — migration 5
-- Run once in the Supabase SQL editor, after migration_4.sql.
-- Shift drop requests (employee asks to be released from a shift).
-- ============================================================================
create table if not exists public.shift_requests (
  id bigint generated always as identity primary key,
  shift_id bigint not null references public.shifts (id) on delete cascade,
  employee_id uuid not null references public.profiles (id) on delete cascade,
  type text not null default 'drop' check (type in ('drop')),
  status text not null default 'pending' check (status in ('pending','approved','denied','cancelled')),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists shift_requests_status_idx on public.shift_requests (status);

alter table public.shift_requests enable row level security;

drop policy if exists sr_select on public.shift_requests;
create policy sr_select on public.shift_requests for select to authenticated
  using (employee_id = auth.uid() or public.is_manager());

drop policy if exists sr_insert on public.shift_requests;
create policy sr_insert on public.shift_requests for insert to authenticated
  with check (employee_id = auth.uid());

drop policy if exists sr_update_own on public.shift_requests;
create policy sr_update_own on public.shift_requests for update to authenticated
  using (employee_id = auth.uid()) with check (employee_id = auth.uid());

drop policy if exists sr_manager on public.shift_requests;
create policy sr_manager on public.shift_requests for all to authenticated
  using (public.is_manager()) with check (public.is_manager());
