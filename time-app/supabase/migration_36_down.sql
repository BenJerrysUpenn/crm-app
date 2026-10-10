-- ============================================================================
-- Withers Time, rollback for migration 36 (the pay table on the payroll page)
--
-- DATA LOST: every row of public.payroll_sheets -- every pay table build and
-- request, with the sheet JSON each build published. The sheets themselves can
-- be rebuilt from the Mac (bj-finance modules/payroll_publish.py, or the .json
-- files it wrote under ~/bj-finance-data/payroll/out), but which build a
-- manager was looking at when they submitted is gone. Export first if wanted:
--
--     copy (select id, window_end, status, requested_by, requested_at, started_at,
--                  built_at, built_by, source_fingerprint, open_items, error
--             from public.payroll_sheets order by id) to stdout with csv header;
--
-- row_audit keeps the payroll_rulings rows it logged while 36 was applied.
--
-- Restores guard_payroll_run_submittal() exactly as migration 27 defined it
-- (no pay-table condition) and stops auditing payroll_rulings. Run in the
-- Supabase SQL editor. Safe to re-run.
-- ============================================================================

begin;

create or replace function public.guard_payroll_run_submittal()
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
    raise exception 'The pay run ending % is submitted. Submittal is final and cannot be undone.', old.window_end;
  end if;

  if tg_op = 'UPDATE' then
    -- Only status may move (§6, not built), and submitted_by may only be
    -- cleared by ON DELETE SET NULL. Everything that says what was submitted,
    -- by whom and when stays as it was given.
    if new.window_end is distinct from old.window_end
       or new.submitted_at is distinct from old.submitted_at
       or new.snapshot is distinct from old.snapshot
       or new.note is distinct from old.note
       or (new.submitted_by is distinct from old.submitted_by and new.submitted_by is not null) then
      raise exception 'The pay run ending % is submitted. Submittal is final and cannot be changed.', old.window_end;
    end if;
    return new;
  end if;

  -- INSERT
  -- The CHECK constraint refuses this too; saying it in words is kinder.
  if (new.window_end - date '2026-09-20') % 14 <> 0 then
    raise exception 'Pay periods end every other Sunday (2026-09-20, 2026-10-04 and so on); % is not one.', new.window_end;
  end if;
  if new.window_end >= v_today then
    raise exception 'The pay period ending % has not ended yet. It can be submitted from %.', new.window_end, new.window_end + 1;
  end if;
  select a.window_end into v_overlap
    from public.payroll_run_submittals a
   where a.window_end <> new.window_end
     and a.window_end between new.window_end - 13 and new.window_end + 13
   limit 1;
  if v_overlap is not null then
    raise exception 'The pay run ending % is already submitted and shares days with this one.', v_overlap;
  end if;
  -- Ruling D: no submittal while a 1.4/1.5 punch, or an open punch (1.1/1.4),
  -- is still uncorrected.
  select string_agg(format('%s punch %s (%s)', b.check_id, b.punch_id, b.work_date), ', ')
    into v_blockers
    from public.payroll_punch_blockers(new.window_end) b;
  if v_blockers is not null then
    raise exception 'Correct these punches in Withers-time first; they have no default: %.', v_blockers;
  end if;
  new.submitted_at := now();
  new.status := 'submitted_pending_stage';
  return new;
end;
$$;

revoke execute on function public.guard_payroll_run_submittal() from public, anon, authenticated, service_role;

drop trigger if exists payroll_rulings_audit on public.payroll_rulings;

drop function if exists public.payroll_inputs_changed_at(date);

-- The guard refuses every DELETE, but a dropped table's rows are not deleted
-- row by row. Drop the trigger first anyway, so nothing below meets it.
drop trigger if exists payroll_sheets_guard on public.payroll_sheets;
drop table if exists public.payroll_sheets;
drop function if exists public.guard_payroll_sheet();

commit;
