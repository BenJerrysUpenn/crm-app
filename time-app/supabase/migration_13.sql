-- ============================================================================
-- Withers Time — migration 13
-- Run once in the Supabase SQL editor, after migration_12.sql.
-- Configurable, color-coded shift types.
-- ============================================================================
create table if not exists public.shift_types (
  id bigint generated always as identity primary key,
  name text not null,
  color text not null default '#10b981',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.shift_types enable row level security;

drop policy if exists shift_types_select on public.shift_types;
create policy shift_types_select on public.shift_types for select to authenticated
  using (true);

drop policy if exists shift_types_manager on public.shift_types;
create policy shift_types_manager on public.shift_types for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- Seed the existing six with distinct colors (only if table is empty).
insert into public.shift_types (name, color, sort_order)
select * from (values
  ('Catering', '#f59e0b', 1),
  ('PENN Opener', '#10b981', 2),
  ('PENN Closer', '#3b82f6', 3),
  ('PENN Swing Shift', '#a855f7', 4),
  ('PENN Weekend Closer', '#ec4899', 5),
  ('Staff Meeting', '#64748b', 6)
) as v(name, color, sort_order)
where not exists (select 1 from public.shift_types);
