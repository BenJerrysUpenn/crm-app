-- ============================================================================
-- Withers Time, migration 36: the pay table on the payroll page
-- Run once in the Supabase SQL editor, after migration_35.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_36_verify.sql. ROLLBACK. supabase/migration_36_down.sql.
--
-- WHY (Alina, 2026-10-05, the first live run). "That submit button allows for
-- no verification of actual payroll numbers or checks. Who is getting paid
-- what? How do I know the hourly rates match hours worked? That solo close was
-- calculated correctly? I need a table that matches QBO for each person."
--
-- The pay numbers are computed by bj-finance modules/payroll_sheet.py, on the
-- Mac, because the tips need the Square and Olo exports there. Vercel can run
-- neither. So the Mac publishes the sheet's JSON HERE and the payroll page
-- renders it, computing nothing (bj-finance modules/payroll_publish.py).
--
-- WHAT THIS ADDS
--   1. payroll_sheets: one row per build of a period's sheet, and per request
--      for one. The page's "Rebuild pay table" inserts a 'queued' row (its API
--      route, with the service-role key); the bj-finance runner daemon on the
--      Mac claims it ('building'), builds the sheet, and finishes it 'built'
--      with the JSON, or 'failed' with the error. A build by hand on the Mac
--      inserts a 'built' row directly. EVERY BUILD IS KEPT: a built or failed
--      row is frozen, and no row is ever deleted. The page shows the latest
--      built row for the period.
--   2. guard_payroll_sheet(): the state machine above, in the database.
--   3. payroll_inputs_changed_at(date): the latest write to a punch, shift or
--      payroll choice that bears on the period.
--   4. row_audit now logs payroll_rulings too (migration 25's trigger
--      function), so resetting a choice to its default -- a DELETE -- leaves a
--      timestamp like every other change.
--   5. guard_payroll_run_submittal() (migration 27) also refuses a submittal
--      unless a pay table is built for the period, it has no open items, and
--      it was built after the latest change (3). The payroll page and its
--      submit route refuse the same, first.
--
-- WHO MAY WRITE. Nobody through PostgREST but the service role. Managers read
-- (RLS, the (select public.is_manager()) wrapper this project requires); there
-- is no insert, update or delete policy, so a signed-in user cannot write a
-- row, and anon/authenticated lose the table privileges as well. The page's
-- API route checks the manager and inserts with the service-role key; the Mac
-- writes over its own database connection.
--
-- "BUILT AFTER THE LATEST CHANGE". started_at is when the build began reading
-- its inputs, on the database's clock (set by the trigger when a request is
-- claimed; given by the publisher, from now(), for a build by hand). A punch,
-- shift or choice written after it may not be in the sheet, so the sheet is
-- stale. (Equal means the same transaction, which only a test can do.) "Bears on the period": a punch or shift whose before- or
-- after-image starts from 00:00 New York on the day before the period (an
-- overnight close runs into its first morning) up to 05:00 on the day after it
-- (a close that runs past midnight on the last night, and the next morning's
-- clock-in that closes a forgotten punch, both land before then; the sheet's
-- business day turns over at 05:00). A punch on the Monday after, at the
-- counter, does not make the table stale. And any choice made from the period
-- or dated inside it.
--
-- NOTHING NEW IS ON /rest/v1/rpc. Every function is SECURITY DEFINER and
-- revoked from public, anon, authenticated and service_role, as in 27. The
-- page reads row_audit itself (manager SELECT, migration 25) to say WHEN a
-- table went stale; this function is the database's own copy of that rule.
-- ============================================================================

begin;

-- ---------- payroll_sheets -----------------------------------------------------
create table if not exists public.payroll_sheets (
  id                 bigint generated always as identity primary key,
  -- The period, by its last day (a Sunday on the cycle, as in migration 27).
  window_end         date        not null,
  status             text        not null default 'queued',
  -- Who pressed Rebuild. Null for a build by hand on the Mac.
  requested_by       uuid        references public.profiles (id) on delete set null,
  requested_at       timestamptz not null default now(),
  -- When the build began reading its inputs (see the header).
  started_at         timestamptz,
  built_at           timestamptz,
  -- The code and host that built it: "modules.payroll_publish@<sha> on <host>".
  built_by           text,
  -- sha256 of the sheet JSON: two builds with the same value pay the same.
  source_fingerprint text,
  -- bj-finance modules.payroll_sheet.render_json, verbatim.
  sheet              jsonb,
  -- len(sheet.open_items): things to fix before the sheet may be keyed.
  open_items         integer,
  error              text
);

alter table public.payroll_sheets drop constraint if exists payroll_sheets_status_check;
alter table public.payroll_sheets add constraint payroll_sheets_status_check
  check (status in ('queued', 'building', 'built', 'failed'));

alter table public.payroll_sheets drop constraint if exists payroll_sheets_window_end_cycle;
alter table public.payroll_sheets add constraint payroll_sheets_window_end_cycle
  check ((window_end - date '2026-09-20') % 14 = 0);

alter table public.payroll_sheets drop constraint if exists payroll_sheets_built_is_complete;
alter table public.payroll_sheets add constraint payroll_sheets_built_is_complete
  check (status <> 'built' or (sheet is not null and built_at is not null and started_at is not null
                               and open_items is not null and open_items >= 0
                               and source_fingerprint is not null));

alter table public.payroll_sheets drop constraint if exists payroll_sheets_failed_says_why;
alter table public.payroll_sheets add constraint payroll_sheets_failed_says_why
  check (status <> 'failed' or error is not null);

-- One request in flight per period: a second press while one is queued or
-- building is answered with the one already there.
create unique index if not exists payroll_sheets_one_pending
  on public.payroll_sheets (window_end) where status in ('queued', 'building');

-- The page's two reads: the latest build of a period, the latest request.
create index if not exists payroll_sheets_built_idx
  on public.payroll_sheets (window_end, built_at desc) where status = 'built';
create index if not exists payroll_sheets_requested_idx
  on public.payroll_sheets (window_end, requested_at desc);
-- The Mac's poll: the oldest queued request.
create index if not exists payroll_sheets_queue_idx
  on public.payroll_sheets (requested_at, id) where status = 'queued';

alter table public.payroll_sheets enable row level security;

drop policy if exists payroll_sheets_manager_select on public.payroll_sheets;
create policy payroll_sheets_manager_select on public.payroll_sheets for select to authenticated
  using ((select public.is_manager()));

revoke insert, update, delete, truncate on public.payroll_sheets from anon, authenticated;

-- ---------- the state machine --------------------------------------------------
create or replace function public.guard_payroll_sheet()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Pay table builds are kept: build % cannot be deleted.', old.id;
  end if;

  if tg_op = 'INSERT' then
    new.requested_at := now();
    if new.status = 'queued' then
      if new.started_at is not null or new.built_at is not null or new.sheet is not null
         or new.open_items is not null or new.source_fingerprint is not null
         or new.built_by is not null or new.error is not null then
        raise exception 'A pay table request carries no build: insert it with only window_end and requested_by.';
      end if;
      return new;
    end if;
    if new.status = 'built' then
      -- A build by hand on the Mac. started_at is when it began reading.
      if new.started_at is null or new.started_at > now() then
        raise exception 'A pay table build needs started_at: when it began reading its inputs, not in the future.';
      end if;
      new.built_at := now();
      new.error := null;
      return new;
    end if;
    raise exception 'A new pay table row is queued or built, not %.', new.status;
  end if;

  -- UPDATE. What a row is for never changes. requested_by may only be cleared
  -- by ON DELETE SET NULL.
  if new.id is distinct from old.id
     or new.window_end is distinct from old.window_end
     or new.requested_at is distinct from old.requested_at
     or (new.requested_by is distinct from old.requested_by and new.requested_by is not null) then
    raise exception 'Pay table build %: what it is for cannot be changed.', old.id;
  end if;

  if old.status in ('built', 'failed') then
    if new.requested_by is null and old.requested_by is not null
       and (to_jsonb(new) - 'requested_by') = (to_jsonb(old) - 'requested_by') then
      return new;
    end if;
    raise exception 'Pay table build % is %: builds are kept as they were made. Rebuild instead.', old.id, old.status;
  end if;

  if old.status = 'queued' and new.status = 'building' then
    new.started_at := now();
    if new.built_at is not null or new.sheet is not null or new.open_items is not null
       or new.source_fingerprint is not null or new.built_by is not null or new.error is not null then
      raise exception 'Pay table build %: claiming a request sets nothing but its status.', old.id;
    end if;
    return new;
  end if;

  if old.status = 'building' and new.status = 'built' then
    if new.started_at is distinct from old.started_at then
      raise exception 'Pay table build %: started_at is set when the request is claimed.', old.id;
    end if;
    new.built_at := now();
    new.error := null;
    return new;
  end if;

  if old.status in ('queued', 'building') and new.status = 'failed' then
    if new.sheet is not null or new.open_items is not null or new.source_fingerprint is not null then
      raise exception 'Pay table build %: a failed build carries no sheet.', old.id;
    end if;
    new.started_at := old.started_at;
    new.built_at := null;
    return new;
  end if;

  raise exception 'Pay table build %: % cannot become %.', old.id, old.status, new.status;
end;
$$;

revoke execute on function public.guard_payroll_sheet() from public, anon, authenticated, service_role;

drop trigger if exists payroll_sheets_guard on public.payroll_sheets;
create trigger payroll_sheets_guard
  before insert or update or delete on public.payroll_sheets
  for each row execute function public.guard_payroll_sheet();

-- ---------- choices are audited too ----------------------------------------------
-- Migration 25's trigger function, unchanged. A reset to the default deletes
-- the choice's row; without this it would leave no timestamp anywhere.
drop trigger if exists payroll_rulings_audit on public.payroll_rulings;
create trigger payroll_rulings_audit
  after insert or update or delete on public.payroll_rulings
  for each row execute function public.audit_row_change();

-- ---------- the latest change that bears on a period ------------------------------
-- lib/payroll/paySheet.ts inputsChangedAt() is the page's copy of this rule.
create or replace function public.payroll_inputs_changed_at(p_window_end date)
returns timestamptz
language sql
stable
security definer set search_path = public
as $$
  select max(x.at) from (
    select a.at
      from public.row_audit a
      cross join lateral (values (a.before_image), (a.after_image)) i(img)
     where a.table_name = 'time_entries'
       and i.img is not null
       and (i.img ->> 'clock_in_at')::timestamptz
           >= (p_window_end - 14)::timestamp at time zone 'America/New_York'
       and (i.img ->> 'clock_in_at')::timestamptz
           < ((p_window_end + 1)::timestamp + interval '5 hours') at time zone 'America/New_York'
    union all
    select a.at
      from public.row_audit a
      cross join lateral (values (a.before_image), (a.after_image)) i(img)
     where a.table_name = 'shifts'
       and i.img is not null
       and (i.img ->> 'starts_at')::timestamptz
           >= (p_window_end - 14)::timestamp at time zone 'America/New_York'
       and (i.img ->> 'starts_at')::timestamptz
           < ((p_window_end + 1)::timestamp + interval '5 hours') at time zone 'America/New_York'
    union all
    select a.at
      from public.row_audit a
      cross join lateral (values (a.before_image), (a.after_image)) i(img)
     where a.table_name = 'payroll_rulings'
       and i.img is not null
       and ((i.img ->> 'window_end')::date = p_window_end
            or (i.img ->> 'case_date')::date between p_window_end - 13 and p_window_end)
    union all
    -- Choices made before this migration started auditing them.
    select greatest(r.decided_at, r.created_at)
      from public.payroll_rulings r
     where r.window_end = p_window_end
        or r.case_date between p_window_end - 13 and p_window_end
  ) x;
$$;

revoke execute on function public.payroll_inputs_changed_at(date) from public, anon, authenticated, service_role;

-- ---------- the submittal: migration 27's guard, plus the pay table -------------
create or replace function public.guard_payroll_run_submittal()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_today    date := (now() at time zone 'America/New_York')::date;
  v_overlap  date;
  v_blockers text;
  v_sheet    public.payroll_sheets%rowtype;
  v_changed  timestamptz;
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
  -- Migration 36: the pay table the submitter was shown is the one being paid.
  select s.* into v_sheet
    from public.payroll_sheets s
   where s.window_end = new.window_end and s.status = 'built'
   order by s.built_at desc, s.id desc
   limit 1;
  if not found then
    raise exception 'Build the pay table for the period ending % first: nobody has checked who is paid what.', new.window_end;
  end if;
  if v_sheet.open_items > 0 then
    raise exception 'The pay table for the period ending % has % open item(s). Fix them, rebuild it, then submit.', new.window_end, v_sheet.open_items;
  end if;
  v_changed := public.payroll_inputs_changed_at(new.window_end);
  if v_changed is not null and v_changed > v_sheet.started_at then
    raise exception 'A punch, shift or choice for the period ending % changed at %, after the pay table was built. Rebuild it, then submit.', new.window_end, v_changed;
  end if;
  new.submitted_at := now();
  new.status := 'submitted_pending_stage';
  return new;
end;
$$;

revoke execute on function public.guard_payroll_run_submittal() from public, anon, authenticated, service_role;

commit;
