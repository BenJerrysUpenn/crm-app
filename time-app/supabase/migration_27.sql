-- ============================================================================
-- Withers Time — migration 27: per-case payroll choices, and one approval per run
-- Run once in the Supabase SQL editor, after migration_26.sql. Safe to re-run.
--
-- Payroll spec §1 (bj-finance #519), as ruled by Alina on 2026-09-22:
--
--   "These are judgement calls per case, made in the app, not fixed rules in
--    the sheet." Each qualifying case gets a choice with a PRESELECTED DEFAULT.
--    Nothing runs until a human hits ONE approve for the whole pay run. ANY
--    manager can change a choice and approve the run.
--
-- The cases (lib/payroll/verify.ts builds them; bj-finance
-- modules/payroll_sheet.py pays them):
--
--   1.9  a solo-close ELIGIBLE night (last in-store clock-out > 2h before
--        close, or a 4h+ solo tail with the closer out before 22:00) → pay
--        the scheduled closer / pay an unpunched manager / skip. Default
--        SKIP. Chosen on the schedule.
--   3.5  a catering event with no crew → who is paid its tip. Default Sophia.
--   3.7  a period with no bake shift worked → who is paid stranded Olo tips.
--        Default Sophia.
--
-- NOT CHOICES (ruling D, 2026-09-22): 1.4, a runaway punch with NO scheduled
-- shift, and 1.5, a punch under 25% of its scheduled shift, have no default
-- and no picker. The punch is corrected in Withers-time. Until every such
-- punch in the period is corrected, payroll_punch_blockers() names it and
-- guard_payroll_run_approval() refuses the approval. payroll_rulings refuses
-- a row for either check.
--
-- TWO TABLES.
--
--   payroll_rulings       — one row per case a manager has CHANGED from its
--                           default. No row means
--                           the default stands: the default is a rule written
--                           in code, and storing it per case would be a second
--                           copy that could disagree with the first. What the
--                           defaults WERE at approval is kept in the approval's
--                           snapshot below, so the record is complete.
--   payroll_run_approvals — one row per pay run: who approved, when, and the
--                           snapshot of every case's effective choice at that
--                           moment, defaults included.
--
-- WHY (check_id, finding_key) IS UNIQUE, NOT PER WINDOW. Every case key is
-- globally unique on its own: `1.9:2026-09-18` names one night, `3.5:deal:25188`
-- one event, `3.7:olo:2026-09-20` one period. The
-- solo-close dropdown lives on the SCHEDULE, which shows calendar weeks rather
-- than pay periods, so a choice made there cannot know which fortnight the
-- Finance tab will verify it in. Keying on the case alone means the schedule,
-- the Finance tab and the payroll sheet all find the same row. window_end is
-- kept as the period the choice was made from, for the record.
--
-- APPROVAL IS FINAL (ruled 2026-09-22, follow-up). Approving a run starts the
-- payroll script that stages it in QuickBooks, so it cannot be cancelled or
-- undone, and it can only be given once the period has ended:
--
--   * ONLY AFTER THE PERIOD ENDS. An approval for a window whose last day is
--     today or later (New York) is refused by guard_payroll_run_approval().
--   * ONLY WITH NO 1.4/1.5 PUNCH LEFT. The same trigger refuses an approval
--     while payroll_punch_blockers() finds any in the window.
--   * ONCE. One row per window (the primary key refuses a second approval);
--     an edit or a delete is refused by the same trigger, whoever asks.
--     Authenticated users have no UPDATE or DELETE policy at all.
--   * IT LOCKS EVERY CHOICE IN THE PERIOD. guard_payroll_ruling() refuses any
--     insert, change or delete of a payroll_rulings row whose case falls inside
--     an approved window. The case's date (payroll_rulings.case_date) is worked
--     out by the trigger from the key itself (the night, the event date, the
--     3.7 window end), never taken from the browser.
--   * NO OVERLAPPING RUNS. A window that shares a day with an approved window
--     is refused: its days are already locked and would be paid twice.
--
-- THE SEAM TO §6 (not built). An approval is written with
-- status = 'approved_pending_stage'. That row is what the future QBO staging
-- script (payroll spec §6) will consume. Nothing in this migration or the app
-- starts it or touches QBO.
-- TODO(bj-finance #519, spec §6): the staging script picks up
-- 'approved_pending_stage' rows. Its own migration widens
-- payroll_run_approvals_status_check with the states it moves a row through,
-- and guard_payroll_run_approval() already lets `status` alone change.
--
-- WHY NOTHING CASCADES FROM profiles. decided_by, payee_id and approved_by are
-- ON DELETE SET NULL: a call made by a manager who later leaves still stands.
-- (For an approved period the lock refuses that SET NULL on payroll_rulings,
-- so a profile paid in an approved run cannot be hard-deleted. Archive it:
-- profiles.active = false.)
-- ============================================================================

create table if not exists public.payroll_rulings (
  id          bigint generated always as identity primary key,
  -- The pay period the choice was made from, by its last day (a Sunday, §0.1).
  window_end  date        not null,
  -- The spec's check number, e.g. '1.9'. Text because that is what it is.
  check_id    text        not null,
  -- The case's stable key from lib/payroll/verify.ts.
  finding_key text        not null,
  -- Validated against the rulebook's vocabulary in the route (RULING_CHOICES).
  choice      text        not null,
  -- The day the case falls on, which decides the pay period it is locked
  -- with. Set by guard_payroll_ruling() from finding_key; any value sent in is
  -- overwritten.
  case_date   date        not null,
  -- The person a paying choice pays (1.9 scheduled_closer/unpunched_manager,
  -- 3.5 and 3.7 staff). Null for skip.
  payee_id    uuid        references public.profiles (id) on delete set null,
  note        text,
  decided_by  uuid        references public.profiles (id) on delete set null,
  decided_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- An earlier draft of this migration had no payee and keyed per window.
alter table public.payroll_rulings
  add column if not exists payee_id uuid references public.profiles (id) on delete set null;
alter table public.payroll_rulings
  add column if not exists case_date date;
drop index if exists public.payroll_rulings_finding_key;

create unique index if not exists payroll_rulings_case_key
  on public.payroll_rulings (check_id, finding_key);

-- Only the choice checks (ruling D, 2026-09-22): 1.4 and 1.5 are corrected in
-- Withers-time, never answered here.
alter table public.payroll_rulings
  drop constraint if exists payroll_rulings_check_id_ck;
alter table public.payroll_rulings
  add constraint payroll_rulings_check_id_ck
  check (check_id in ('1.9', '3.5', '3.7'));

create index if not exists payroll_rulings_window_idx
  on public.payroll_rulings (window_end);

alter table public.payroll_rulings enable row level security;

-- Managers only, read and write. A choice decides what somebody is paid.
-- The (select public.is_manager()) wrapper is mandatory in this project: a bare
-- is_manager() is re-evaluated per row and has caused statement timeouts.
drop policy if exists payroll_rulings_manager_all on public.payroll_rulings;
create policy payroll_rulings_manager_all on public.payroll_rulings for all to authenticated
  using ((select public.is_manager())) with check ((select public.is_manager()));

-- ---------- payroll_run_approvals -------------------------------------------
create table if not exists public.payroll_run_approvals (
  -- One approval per pay run, identified by the period's last day.
  window_end   date        primary key,
  approved_by  uuid        references public.profiles (id) on delete set null,
  approved_at  timestamptz not null default now(),
  -- Every case's effective choice at the moment of approval:
  -- [{ key, check, choice, payee_id, payee_name, source: 'recorded'|'default' }]
  snapshot     jsonb       not null default '[]'::jsonb,
  note         text,
  -- The seam to §6. See the header: the staging script consumes
  -- 'approved_pending_stage'.
  status       text        not null default 'approved_pending_stage'
);

-- An earlier draft had no status.
alter table public.payroll_run_approvals
  add column if not exists status text not null default 'approved_pending_stage';

-- TODO(bj-finance #519, spec §6): the staging script's migration adds its states here.
alter table public.payroll_run_approvals
  drop constraint if exists payroll_run_approvals_status_check;
alter table public.payroll_run_approvals
  add constraint payroll_run_approvals_status_check
  check (status in ('approved_pending_stage'));

-- Pay periods end on a Sunday (§0.1). ISO day of week 7 is Sunday.
alter table public.payroll_run_approvals
  drop constraint if exists payroll_run_approvals_window_end_sunday;
alter table public.payroll_run_approvals
  add constraint payroll_run_approvals_window_end_sunday
  check (extract(isodow from window_end) = 7);

alter table public.payroll_run_approvals enable row level security;

-- Managers read every approval and may give one, as themselves. There is no
-- UPDATE or DELETE policy: an approval is final.
drop policy if exists payroll_run_approvals_manager_all on public.payroll_run_approvals;
drop policy if exists payroll_run_approvals_manager_select on public.payroll_run_approvals;
drop policy if exists payroll_run_approvals_manager_insert on public.payroll_run_approvals;
create policy payroll_run_approvals_manager_select on public.payroll_run_approvals for select to authenticated
  using ((select public.is_manager()));
create policy payroll_run_approvals_manager_insert on public.payroll_run_approvals for insert to authenticated
  with check ((select public.is_manager()) and approved_by = (select auth.uid()));

-- ---------- the pay period a case belongs to ---------------------------------
-- The day a case falls on, from its key, the same way lib/payroll/verify.ts
-- dates it. Null when the key names nothing this can date (the insert is then
-- refused: a choice that cannot be placed in a period cannot be locked).
create or replace function public.payroll_case_date(p_check text, p_key text)
returns date
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_tail text := substring(p_key from '[^:]+$');
  v_date date;
begin
  if p_check = '1.9' and p_key ~ '^1\.9:\d{4}-\d{2}-\d{2}$' then
    return v_tail::date;
  elsif p_check = '3.7' and p_key ~ '^3\.7:olo:\d{4}-\d{2}-\d{2}$' then
    return v_tail::date;
  elsif p_check = '3.5' and p_key ~ '^3\.5:deal:\d+$' then
    -- deals.event_date is text holding an ISO date (the CRM's column).
    select left(d.event_date, 10)::date into v_date
      from public.deals d
     where d.id = v_tail::bigint
       and d.event_date ~ '^\d{4}-\d{2}-\d{2}';
    return v_date;
  end if;
  return null;
end;
$$;

-- The approved window whose 14 days contain p_date, if any.
create or replace function public.payroll_approved_window_for(p_date date)
returns date
language sql
stable
security definer set search_path = public
as $$
  select a.window_end
    from public.payroll_run_approvals a
   where p_date between a.window_end - 13 and a.window_end
   order by a.window_end
   limit 1;
$$;

-- ---------- the lock on choices ----------------------------------------------
create or replace function public.guard_payroll_ruling()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_locked date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_locked := public.payroll_approved_window_for(old.case_date);
    if v_locked is not null then
      raise exception 'The pay run ending % is approved. Its choices are locked: approval is final.', v_locked;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  new.case_date := public.payroll_case_date(new.check_id, new.finding_key);
  if new.case_date is null then
    raise exception 'Cannot tell which pay period % belongs to, so it cannot be recorded.', new.finding_key;
  end if;
  v_locked := public.payroll_approved_window_for(new.case_date);
  if v_locked is not null then
    raise exception 'The pay run ending % is approved. Its choices are locked: approval is final.', v_locked;
  end if;
  return new;
end;
$$;

drop trigger if exists payroll_rulings_lock on public.payroll_rulings;
create trigger payroll_rulings_lock
  before insert or update or delete on public.payroll_rulings
  for each row execute function public.guard_payroll_ruling();

-- ---------- 1.4 / 1.5: punches that must be corrected first ------------------
-- Ruling D (2026-09-22). The same rules lib/payroll/verify.ts applies, over
-- every closed punch whose New York day is inside the window ending
-- p_window_end:
--
--   1.4  a runaway — over 15h (lib/shiftChecks.ts LONG_SHIFT_HOURS), or
--        closed within 5s of the same person's next clock-in (1.3) — with NO
--        scheduled shift by the 1.10 ladder.
--   1.5  not a runaway, matched to a scheduled shift by the 1.10 ladder, and
--        under 25% of that shift's length.
--
-- The 1.10 ladder: the punch's own shift_id; else the person's shift that
-- day it overlaps most; else somebody else's shift that day, which that
-- person did not punch for, bracketing the punch within 30 minutes (a cover).
-- The Finance tab reports the same punches as needs_fix and disables Approve;
-- this is the database's own copy of that refusal.
create or replace function public.payroll_punch_blockers(p_window_end date)
returns table (check_id text, punch_id bigint, employee_id uuid, work_date date)
language sql
stable
security definer set search_path = public
as $$
  with p as (
    select t.id, t.employee_id, t.shift_id, t.clock_in_at, t.clock_out_at,
           (t.clock_in_at at time zone 'America/New_York')::date as d,
           extract(epoch from (t.clock_out_at - t.clock_in_at)) / 3600.0 as hours
      from public.time_entries t
     where t.clock_out_at is not null
       and (t.clock_in_at at time zone 'America/New_York')::date
           between p_window_end - 13 and p_window_end
  ),
  classified as (
    select p.*,
           (p.hours > 15
            or abs(extract(epoch from (nx.clock_in_at - p.clock_out_at))) <= 5) as runaway,
           coalesce(ex.id, own.id, cov.id) as matched_shift,
           coalesce(ex.len, own.len, cov.len) as scheduled_hours
      from p
      left join lateral (
        select n.clock_in_at
          from public.time_entries n
         where n.employee_id = p.employee_id
           and (n.clock_in_at, n.id) > (p.clock_in_at, p.id)
         order by n.clock_in_at, n.id
         limit 1
      ) nx on true
      left join lateral (
        select s.id, extract(epoch from (s.ends_at - s.starts_at)) / 3600.0 as len
          from public.shifts s
         where s.id = p.shift_id
      ) ex on true
      left join lateral (
        select s.id, extract(epoch from (s.ends_at - s.starts_at)) / 3600.0 as len
          from public.shifts s
         where s.employee_id = p.employee_id
           and (s.starts_at at time zone 'America/New_York')::date = p.d
           and least(s.ends_at, p.clock_out_at) >= greatest(s.starts_at, p.clock_in_at)
         order by least(s.ends_at, p.clock_out_at) - greatest(s.starts_at, p.clock_in_at) desc,
                  s.starts_at, s.id
         limit 1
      ) own on true
      left join lateral (
        select s.id, extract(epoch from (s.ends_at - s.starts_at)) / 3600.0 as len
          from public.shifts s
         where s.employee_id is not null
           and s.employee_id <> p.employee_id
           and (s.starts_at at time zone 'America/New_York')::date = p.d
           and not exists (
             select 1 from public.time_entries o
              where o.employee_id = s.employee_id
                and (o.clock_in_at at time zone 'America/New_York')::date = p.d)
           and p.clock_in_at >= s.starts_at - interval '30 minutes'
           and p.clock_out_at <= s.ends_at + interval '30 minutes'
           and least(s.ends_at, p.clock_out_at) >= greatest(s.starts_at, p.clock_in_at)
         order by least(s.ends_at, p.clock_out_at) - greatest(s.starts_at, p.clock_in_at) desc,
                  s.starts_at, s.id
         limit 1
      ) cov on true
  )
  select '1.4'::text, c.id, c.employee_id, c.d
    from classified c
   where c.runaway and c.matched_shift is null
  union all
  select '1.5'::text, c.id, c.employee_id, c.d
    from classified c
   where not c.runaway
     and c.matched_shift is not null
     and c.scheduled_hours > 0
     and c.hours < 0.25 * c.scheduled_hours
   order by 4, 2;
$$;

-- ---------- the approval: after the period, once, final ----------------------
create or replace function public.guard_payroll_run_approval()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_today    date := (now() at time zone 'America/New_York')::date;
  v_overlap  date;
  v_blockers text;
begin
  if tg_op = 'DELETE' then
    raise exception 'The pay run ending % is approved. Approval is final and cannot be undone.', old.window_end;
  end if;

  if tg_op = 'UPDATE' then
    -- Only status may move (§6, not built), and approved_by may only be
    -- cleared by ON DELETE SET NULL. Everything that says what was approved,
    -- by whom and when stays as it was given.
    if new.window_end is distinct from old.window_end
       or new.approved_at is distinct from old.approved_at
       or new.snapshot is distinct from old.snapshot
       or new.note is distinct from old.note
       or (new.approved_by is distinct from old.approved_by and new.approved_by is not null) then
      raise exception 'The pay run ending % is approved. Approval is final and cannot be changed.', old.window_end;
    end if;
    return new;
  end if;

  -- INSERT
  if new.window_end >= v_today then
    raise exception 'The pay period ending % has not ended yet. It can be approved from %.', new.window_end, new.window_end + 1;
  end if;
  select a.window_end into v_overlap
    from public.payroll_run_approvals a
   where a.window_end <> new.window_end
     and a.window_end between new.window_end - 13 and new.window_end + 13
   limit 1;
  if v_overlap is not null then
    raise exception 'The pay run ending % is already approved and shares days with this one.', v_overlap;
  end if;
  -- Ruling D: no approval while a 1.4/1.5 punch is still uncorrected.
  select string_agg(format('%s punch %s (%s)', b.check_id, b.punch_id, b.work_date), ', ')
    into v_blockers
    from public.payroll_punch_blockers(new.window_end) b;
  if v_blockers is not null then
    raise exception 'Correct these punches in Withers-time first; they have no default: %.', v_blockers;
  end if;
  new.approved_at := now();
  new.status := 'approved_pending_stage';
  return new;
end;
$$;

drop trigger if exists payroll_run_approvals_guard on public.payroll_run_approvals;
create trigger payroll_run_approvals_guard
  before insert or update or delete on public.payroll_run_approvals
  for each row execute function public.guard_payroll_run_approval();
