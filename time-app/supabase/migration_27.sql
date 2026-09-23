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
--   1.4  a runaway punch with NO scheduled shift → real hours / void (no default)
--   1.5  a punch under 25% of its scheduled shift → as punched / scheduled (no default)
--   1.9  a night nobody's punch closed the store → pay the scheduled closer /
--        pay an unpunched manager / skip. Default SKIP. Chosen on the schedule.
--   3.5  a catering event with no crew → who is paid its tip. Default Sophia.
--   3.7  a period with no bake shift worked → who is paid stranded Olo tips.
--        Default Sophia.
--
-- TWO TABLES.
--
--   payroll_rulings       — one row per case a manager has CHANGED from its
--                           default (or answered, for 1.4/1.5). No row means
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
-- one event, `1.5:punch:1281` one punch, `3.7:olo:2026-09-20` one period. The
-- solo-close dropdown lives on the SCHEDULE, which shows calendar weeks rather
-- than pay periods, so a choice made there cannot know which fortnight the
-- Finance tab will verify it in. Keying on the case alone means the schedule,
-- the Finance tab and the payroll sheet all find the same row. window_end is
-- kept as the period the choice was made from, for the record.
--
-- WHY AN APPROVAL CAN GO STALE. The approval is of the choices as they stood.
-- A choice recorded after approved_at reopens the run (the app shows it STALE,
-- and the payroll sheet refuses to run on it) — computed from the timestamps,
-- so no trigger has to remember to clear anything.
--
-- WHY NOTHING CASCADES FROM profiles. decided_by, payee_id and approved_by are
-- ON DELETE SET NULL: a call made by a manager who later leaves still stands.
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
  -- The person a paying choice pays (1.9 scheduled_closer/unpunched_manager,
  -- 3.5 and 3.7 staff). Null for skip and for every 1.4/1.5 answer.
  payee_id    uuid        references public.profiles (id) on delete set null,
  note        text,
  decided_by  uuid        references public.profiles (id) on delete set null,
  decided_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- An earlier draft of this migration had no payee and keyed per window.
alter table public.payroll_rulings
  add column if not exists payee_id uuid references public.profiles (id) on delete set null;
drop index if exists public.payroll_rulings_finding_key;

create unique index if not exists payroll_rulings_case_key
  on public.payroll_rulings (check_id, finding_key);

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
  note         text
);

alter table public.payroll_run_approvals enable row level security;

drop policy if exists payroll_run_approvals_manager_all on public.payroll_run_approvals;
create policy payroll_run_approvals_manager_all on public.payroll_run_approvals for all to authenticated
  using ((select public.is_manager())) with check ((select public.is_manager()));
