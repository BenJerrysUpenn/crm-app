-- ============================================================================
-- Withers Time, rollback for migration 43 (the control board's dated settings
-- and salaries). Run in the Supabase SQL editor. Safe to re-run.
--
-- DATA LOST: every value the owners entered on the control board and every
-- salary entered on the Team page, with all their history. Nothing else holds
-- a copy, so export both tables first if they may be wanted again:
--   select * from public.control_settings order by key, effective_from, id;
--   select * from public.profile_salaries order by profile_id, effective_from, id;
--
-- WITH THE NEW CODE STILL LIVE. The Targets tab says the board needs
-- migration 43 and saves nothing (503); the Team page shows no salaries. The
-- other finance tabs and the Team page work as before.
--
-- ORDER. Run this before migration_42_down.sql if both are rolled back: these
-- policies call public.is_owner(), which that file drops.
-- ============================================================================

begin;

drop function if exists public.control_settings_on(date);
drop function if exists public.profile_salaries_on(date);
drop table if exists public.control_settings;
drop table if exists public.profile_salaries;
drop function if exists public.stamp_control_row();

commit;
