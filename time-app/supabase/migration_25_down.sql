-- ============================================================================
-- Withers Time — rollback for migration 25 (audit trail)
--
-- DATA LOST: every row in public.row_audit, which is the whole write log for
-- time_entries and shifts since migration 25 ran: every before-image of a
-- deleted or edited punch or shift, and who made each change. It cannot be
-- rebuilt. Export the table first if there is any chance it will be wanted:
--
--     copy (select * from public.row_audit order by id) to stdout with csv header;
--
-- Nothing else is touched: time_entries and shifts keep every row and column.
--
-- ORDER. Migrations 26 and 27 do not depend on anything here, but the payroll
-- verifier reads row_audit, so roll back 27 and 26 first if the whole payroll
-- stack is going. Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

begin;

drop trigger if exists time_entries_audit on public.time_entries;
drop trigger if exists shifts_audit on public.shifts;

drop function if exists public.audit_row_change();

-- Takes the row_audit_manager_select policy and both indexes with it.
drop table if exists public.row_audit;

commit;
