-- ============================================================================
-- Withers Time — migration 19: clock-in reminders
-- Run once in the Supabase SQL editor, after migration_18.sql.
--
-- A manager publishes a reminder; every employee must acknowledge it before
-- the app will let them clock in. The acknowledgment is a signed record kept
-- in perpetuity: it snapshots the exact wording the employee agreed to, and
-- neither the reminder text nor the ack row can be edited or deleted.
--
-- Managers retire a reminder (active = false) instead of editing it. A
-- changed message is a new reminder, so what each person acknowledged stays
-- unambiguous.
-- ============================================================================

create table if not exists public.clockin_reminders (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create index if not exists clockin_reminders_active_idx
  on public.clockin_reminders (active, created_at);

create table if not exists public.clockin_reminder_acks (
  id bigint generated always as identity primary key,
  reminder_id bigint not null references public.clockin_reminders(id),
  employee_id uuid not null references public.profiles(id),
  acknowledged_at timestamptz not null default now(),
  title_snapshot text not null,
  body_snapshot text not null,
  user_agent text,
  unique (reminder_id, employee_id)
);
create index if not exists clockin_reminder_acks_employee_idx
  on public.clockin_reminder_acks (employee_id);

-- ---------------------------------------------------------------------------
-- Immutability. The wording is what was signed for, so it never changes.
-- ---------------------------------------------------------------------------
create or replace function public.clockin_reminders_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.title is distinct from old.title or new.body is distinct from old.body then
    raise exception
      'clockin_reminders.title/body are immutable; retire this reminder and publish a new one';
  end if;
  return new;
end;
$$;

drop trigger if exists clockin_reminders_immutable_trg on public.clockin_reminders;
create trigger clockin_reminders_immutable_trg
  before update on public.clockin_reminders
  for each row execute function public.clockin_reminders_immutable();

-- A reminder that anyone has acknowledged can never be deleted: the acks
-- reference it, and deleting it would orphan the signed record.
create or replace function public.clockin_reminders_no_delete_with_acks()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.clockin_reminder_acks a where a.reminder_id = old.id) then
    raise exception
      'clockin_reminders rows with acknowledgments cannot be deleted; set active = false instead';
  end if;
  return old;
end;
$$;

drop trigger if exists clockin_reminders_no_delete_trg on public.clockin_reminders;
create trigger clockin_reminders_no_delete_trg
  before delete on public.clockin_reminders
  for each row execute function public.clockin_reminders_no_delete_with_acks();

create or replace function public.clockin_reminder_acks_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'clockin_reminder_acks rows are a permanent signed record; they cannot be %d',
    lower(tg_op);
  return null;
end;
$$;

drop trigger if exists clockin_reminder_acks_immutable_trg on public.clockin_reminder_acks;
create trigger clockin_reminder_acks_immutable_trg
  before update on public.clockin_reminder_acks
  for each row execute function public.clockin_reminder_acks_immutable();

drop trigger if exists clockin_reminder_acks_no_delete_trg on public.clockin_reminder_acks;
create trigger clockin_reminder_acks_no_delete_trg
  before delete on public.clockin_reminder_acks
  for each row execute function public.clockin_reminder_acks_immutable();

-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------
alter table public.clockin_reminders enable row level security;
alter table public.clockin_reminder_acks enable row level security;

-- Everyone signed in can read reminders (the app pops up the pending ones).
drop policy if exists clockin_reminders_select on public.clockin_reminders;
create policy clockin_reminders_select on public.clockin_reminders for select to authenticated
  using (true);

-- Only managers publish, and only managers retire / re-activate.
-- There is deliberately no delete policy.
drop policy if exists clockin_reminders_insert on public.clockin_reminders;
create policy clockin_reminders_insert on public.clockin_reminders for insert to authenticated
  with check (public.is_manager());
drop policy if exists clockin_reminders_update on public.clockin_reminders;
create policy clockin_reminders_update on public.clockin_reminders for update to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- An employee sees their own acks; managers see everyone's.
drop policy if exists clockin_reminder_acks_select on public.clockin_reminder_acks;
create policy clockin_reminder_acks_select on public.clockin_reminder_acks for select to authenticated
  using (employee_id = auth.uid() or public.is_manager());

-- You can only sign for yourself. No update or delete policy exists for
-- anyone, including managers: the acks are the signed record.
drop policy if exists clockin_reminder_acks_insert on public.clockin_reminder_acks;
create policy clockin_reminder_acks_insert on public.clockin_reminder_acks for insert to authenticated
  with check (employee_id = auth.uid());
