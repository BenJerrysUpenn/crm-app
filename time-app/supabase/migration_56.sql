-- ============================================================================
-- Withers Time, migration 56: the bookkeeping pass history
-- Run once, after migration_54.sql (55 is crm-app #147, independent of this
-- one). Safe to re-run.
--
-- VERIFY. supabase/migration_56_verify.sql. ROLLBACK. supabase/migration_56_down.sql.
--
-- WHY (Alina, 2026-11-13, bj-finance #937). A bookkeeping pass's run log is a
-- record, not a code change, so it should never wait on a merge. Until now
-- DAILY-02, DAILY-03 and WEEKLY-02 appended their run log to markdown files
-- in bj-finance and opened a pull request for it: 47 of the 113 open PRs on
-- 2026-11-13. From this migration on, each pass run writes one row here and
-- the finance app's Metrics page shows the history as a card. A bookkeeping
-- RULE change a pass produces still goes in its own pull request to
-- Bookkeeping_Rules.md, because rulings live in the repo.
--
-- WHAT THIS ADDS
--   bookkeeping_pass_runs: one row per pass run.
--     run_date      the day the pass ran (New York).
--     pass_code     which pass: 'DAILY-02', 'DAILY-03', 'WEEKLY-02', or a
--                   later one of the same shape.
--     run_label     '' for the day's run. A second sitting the same day
--                   (an attended follow-up, an evening session) names itself,
--                   so it gets its own row.
--     attended      true when a person sat with the pass; false for the
--                   scheduled, unattended run.
--     posted_count, posted_dollars   what the pass booked in QBO.
--     queue_before, queue_after      QBO's For Review count before and after.
--     cash          the cash figure, for a pass that has one.
--     issues_filed  bj-finance issue numbers the run filed.
--     note          a short note in plain words.
--     details       the full log text, where there is more than the note
--                   (the backfill keeps each old log entry here verbatim).
--     source        'pass' (written by the run) or 'backfill' (imported from
--                   the old markdown logs and run-log PRs by bj-finance's
--                   modules.pass_history backfill).
--     source_ref    where a backfilled row came from (file or PR).
--     written_by    the code and host that wrote it.
--
-- ONE ROW PER (run_date, pass_code, run_label). A re-run of the same pass on
-- the same day updates its row instead of adding another
-- (insert ... on conflict ... do update); updated_at moves, created_at stays.
--
-- WHO MAY WRITE. Nobody through PostgREST: the passes write over the Mac's
-- own database connection (the DSN in ~/.config/bj-catering/env), as
-- metrics_publish and payroll_publish do. Managers and owners read (RLS with
-- the (select public.is_manager()) wrapper; is_manager() is true for owners,
-- migration 42).
-- ============================================================================

begin;

create table if not exists public.bookkeeping_pass_runs (
  id              bigint generated always as identity primary key,
  run_date        date        not null,
  pass_code       text        not null,
  run_label       text        not null default '',
  attended        boolean     not null,
  posted_count    integer,
  posted_dollars  numeric(12, 2),
  queue_before    integer,
  queue_after     integer,
  cash            numeric(12, 2),
  issues_filed    integer[]   not null default '{}',
  note            text        not null default '',
  details         text,
  source          text        not null default 'pass',
  source_ref      text,
  written_by      text        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.bookkeeping_pass_runs drop constraint if exists bookkeeping_pass_runs_one_per_run;
alter table public.bookkeeping_pass_runs add constraint bookkeeping_pass_runs_one_per_run
  unique (run_date, pass_code, run_label);

alter table public.bookkeeping_pass_runs drop constraint if exists bookkeeping_pass_runs_pass_code;
alter table public.bookkeeping_pass_runs add constraint bookkeeping_pass_runs_pass_code
  check (pass_code ~ '^[A-Z]+-[0-9]{2}$');

alter table public.bookkeeping_pass_runs drop constraint if exists bookkeeping_pass_runs_counts;
alter table public.bookkeeping_pass_runs add constraint bookkeeping_pass_runs_counts
  check (coalesce(posted_count, 0) >= 0 and coalesce(queue_before, 0) >= 0 and coalesce(queue_after, 0) >= 0);

alter table public.bookkeeping_pass_runs drop constraint if exists bookkeeping_pass_runs_source;
alter table public.bookkeeping_pass_runs add constraint bookkeeping_pass_runs_source
  check (source in ('pass', 'backfill'));

alter table public.bookkeeping_pass_runs drop constraint if exists bookkeeping_pass_runs_note_short;
alter table public.bookkeeping_pass_runs add constraint bookkeeping_pass_runs_note_short
  check (char_length(note) <= 2000);

-- The card's read: the runs of the last few months, oldest first.
create index if not exists bookkeeping_pass_runs_date_idx
  on public.bookkeeping_pass_runs (run_date desc);

alter table public.bookkeeping_pass_runs enable row level security;

drop policy if exists bookkeeping_pass_runs_manager_select on public.bookkeeping_pass_runs;
create policy bookkeeping_pass_runs_manager_select on public.bookkeeping_pass_runs for select to authenticated
  using ((select public.is_manager()));

revoke insert, update, delete, truncate on public.bookkeeping_pass_runs from anon, authenticated;
revoke all on public.bookkeeping_pass_runs from anon;

-- created_at is when the run first wrote; updated_at is the last re-run.
create or replace function public.touch_bookkeeping_pass_run()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end
$$;

revoke execute on function public.touch_bookkeeping_pass_run() from public, anon, authenticated;

drop trigger if exists bookkeeping_pass_runs_touch on public.bookkeeping_pass_runs;
create trigger bookkeeping_pass_runs_touch before insert or update on public.bookkeeping_pass_runs
  for each row execute function public.touch_bookkeeping_pass_run();

commit;
