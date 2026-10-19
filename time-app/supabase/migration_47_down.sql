-- ============================================================================
-- Withers Time, rollback for migration 47 (Labor Hours Planning inputs).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- DATA LOST: every store-hours season, concession event and day of
-- catering history. The readers go back to the standing store_hours
-- pattern for every date. bj-finance's loader rewrites the history from the
-- When I Work archive (`python -m modules.labor_planning history --schedule
-- <the export> --apply`); `python -m modules.labor_planning inputs --apply`
-- rewrites the seasons and events from the owners' inputs file.
-- ============================================================================

begin;

drop table if exists public.catering_hours_history;
drop function if exists public.touch_catering_hours_history();
drop table if exists public.concession_events;
drop table if exists public.store_hours_seasons;
drop function if exists public.stamp_store_hours_season();

commit;
