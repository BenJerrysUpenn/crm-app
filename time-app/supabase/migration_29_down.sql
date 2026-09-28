-- ============================================================================
-- Withers Time — rollback for migration 29 (plain shifts_deal_slot_uidx)
--
-- Puts shifts_deal_slot_uidx back to migration 18's PARTIAL unique index
-- (where deal_id is not null). Same order as the migration: the partial index
-- is built under a temporary name before the plain one is dropped, so the
-- one-shift-per-crew-slot rule holds throughout.
--
-- WHAT BREAKS AGAIN. The web routes' inserts (POST /api/deals/:id/booked-shifts
-- and GET /api/cron/catering-shifts) send ON CONFLICT (deal_id, deal_slot) with
-- no predicate, which cannot infer a partial index, so every insert is refused
-- (crm-app #35). The local reconcile CLI repeats the predicate and keeps
-- working.
--
-- DATA LOST: none. Only the index changes.
--
-- Run in the Supabase SQL editor (or psql against the direct DSN). Safe to
-- re-run.
-- ============================================================================

begin;

drop index if exists public.shifts_deal_slot_uidx_partial;
create unique index shifts_deal_slot_uidx_partial
  on public.shifts (deal_id, deal_slot) where deal_id is not null;
drop index public.shifts_deal_slot_uidx;
alter index public.shifts_deal_slot_uidx_partial rename to shifts_deal_slot_uidx;

commit;
