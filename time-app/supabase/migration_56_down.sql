-- ============================================================================
-- Withers Time, rollback for migration 56 (the bookkeeping pass history).
-- Run by hand. Safe to re-run.
--
-- DATA LOST: every pass run row, including the history the backfill imported
-- from bj-finance's old markdown run logs and run-log PRs. The backfill can
-- be run again (bj-finance `python -m modules.pass_history backfill`): the
-- markdown on bj-finance main and the closed run-log PRs' branches still hold
-- that history. Rows the passes wrote after the migration are not kept
-- anywhere else.
-- After this rollback the passes' `modules.pass_history record` exits 2 and
-- says the table is missing; the pass reports it in its email.
-- ============================================================================

begin;

drop table if exists public.bookkeeping_pass_runs;
drop function if exists public.touch_bookkeeping_pass_run();

commit;
