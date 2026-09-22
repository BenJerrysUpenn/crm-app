-- ============================================================================
-- Withers Time — migration 27: recorded payroll rulings
-- Run once in the Supabase SQL editor, after migration_26.sql. Safe to re-run.
--
-- Payroll spec §1 (bj-finance #519): "the button turns green only when every
-- finding is either auto-resolved by rule or has a recorded ruling."
--
-- A RULING is the spec's third class of step: code cannot decide, so the screen
-- shows both bases with dollars and records the choice. Three checks produce
-- them (lib/payroll/verify.ts):
--
--   1.4  a runaway punch with NO scheduled shift → real hours / void
--   1.5  a punch under 25% of its scheduled shift → as punched / scheduled
--   1.9  the store closing >2h after the last punch out → early close /
--        salaried cover, defaulting to salaried cover (Sophia, 2026-09-21:
--        "if it's missing a punch it would be me closing")
--
-- The 2026-09-23 run answered all three by asking Sophia in person, and the
-- answers exist nowhere. This table is where they live: what was asked, what
-- was chosen, by whom, when.
--
-- WHY (window_end, check_id, finding_key). A ruling answers one finding in one
-- pay window, and the finding keys are built to be stable across re-runs of the
-- same window (`1.9:2026-09-18`, `1.5:punch:1281`). So the same question asked
-- twice gets one row, re-running Verify keeps the answers, and a finding that
-- stops occurring — because the data was fixed — leaves an orphan row that is
-- simply never read again rather than a wrong answer attached to something else.
--
-- WHY THE CHOICE IS TEXT AND NOT AN ENUM. The options are computed per finding
-- by the rulebook, which is TypeScript and versioned with the app; a Postgres
-- enum would mean a migration every time a check gains an option, and an enum
-- that disagreed with the rulebook would be the worse of the two. The choice is
-- validated against the finding's own options in the route before it is stored.
--
-- WHY NOTHING CASCADES FROM profiles. decided_by is ON DELETE SET NULL, not
-- CASCADE: if the manager who made a call later leaves, the call still stands
-- and the row must survive them. An unattributed ruling is worth far more than
-- a deleted one.
-- ============================================================================

create table if not exists public.payroll_rulings (
  id          bigint generated always as identity primary key,
  -- The pay period this answers, identified by its last day (a Sunday, §0.1).
  window_end  date        not null,
  -- The spec's check number, e.g. '1.9'. Text because that is what it is.
  check_id    text        not null,
  -- The finding's stable key from lib/payroll/verify.ts.
  finding_key text        not null,
  choice      text        not null,
  note        text,
  decided_by  uuid        references public.profiles (id) on delete set null,
  decided_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create unique index if not exists payroll_rulings_finding_key
  on public.payroll_rulings (window_end, check_id, finding_key);

create index if not exists payroll_rulings_window_idx
  on public.payroll_rulings (window_end);

alter table public.payroll_rulings enable row level security;

-- Managers only, read and write. A ruling decides what somebody is paid.
-- The (select public.is_manager()) wrapper is mandatory in this project: a bare
-- is_manager() is re-evaluated per row and has caused statement timeouts.
drop policy if exists payroll_rulings_manager_all on public.payroll_rulings;
create policy payroll_rulings_manager_all on public.payroll_rulings for all to authenticated
  using ((select public.is_manager())) with check ((select public.is_manager()));
