-- ============================================================================
-- Withers Time, rollback for migration 57 (metrics_snapshots kind 'sales_lanes').
-- Run by hand. Safe to re-run.
--
-- DATA LOST: every 'sales_lanes' snapshot. The guard trigger keeps every
-- publish as published, so the rows can only go with the trigger switched
-- off for the delete; it is switched back on in the same transaction. The
-- publisher can build today's numbers again; earlier days' snapshots are not
-- kept anywhere else.
-- Turn the sales lanes publisher off first: after this rollback its insert is
-- refused by the kind check.
-- ============================================================================

begin;

alter table public.metrics_snapshots disable trigger metrics_snapshots_guard;
delete from public.metrics_snapshots where kind = 'sales_lanes';
alter table public.metrics_snapshots enable trigger metrics_snapshots_guard;

alter table public.metrics_snapshots drop constraint if exists metrics_snapshots_kind_check;
alter table public.metrics_snapshots add constraint metrics_snapshots_kind_check
  check (kind in ('daily', 'closed_month'));

commit;
