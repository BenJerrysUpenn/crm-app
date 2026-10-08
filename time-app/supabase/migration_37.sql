-- ============================================================================
-- Withers Time, migration 37: Travel Reimbursements
-- Run once in the Supabase SQL editor, after migration_36.sql. Safe to re-run.
-- (Numbers 23 and 31 are held by open PRs; this file does not depend on them.)
--
-- VERIFY. supabase/migration_37_verify.sql. ROLLBACK. supabase/migration_37_down.sql.
--
-- WHY (bj-finance #210, rulings 1-39, confirmed by Alina 2026-10-08). Staff
-- log their own travel in Withers Time instead of Sophia's processing-day
-- email. One Travel Reimbursement per Reason (Groceries / errands, or one
-- Catering Event): Mileage in their own car at the IRS rate for the trip date,
-- plus optional tolls and parking, with Receipts. An Approver decides it; the
-- pay table pays it as the non-taxable Travel Reimbursement line; payroll marks
-- it Paid. A Lyft ride on the company card is recorded as a Lyft ride report,
-- Filed on upload, with nothing to approve or pay. Words: GLOSSARY.md.
--
-- WHAT THIS ADDS
--   1. mileage_rates: the IRS business standard mileage rate by start date.
--      A new rate is added by hand here (ruling 38): insert (starts_on,
--      cents_per_mile, source). Every reimbursement not yet Paid is priced at
--      its trip date's rate when it is read; nothing is frozen at submit (33).
--   2. travel_reimbursements: one row per Travel Reimbursement, its Reason,
--      Mileage, tolls, parking, Receipts (paths in the storage bucket, 5) and
--      its status: submitted | approved | rejected | paid | paid_outside_payroll.
--   3. travel_reimbursement_adjustments: every Adjustment an Approver makes
--      to an amount, with old and new cents, a one-line note and the evidence
--      file (34). The row's amount columns carry the current amounts; this log
--      keeps the originals.
--   4. lyft_ride_reports: Lyft ride report screenshots against a Reason. Filed
--      on insert; no status, never approved or paid (23).
--   5. guard_travel_reimbursement(): the lifecycle in the database, as
--      lib/reimbursements/lifecycle.ts has it in the app (see the trigger).
--   6. THE PAYROLL SEAM, for bj-finance's pay table build (rulings 22, 32):
--        travel_reimbursements_payable   view: Approved, unpaid, payroll staff
--                                        (owners excluded), with mileage,
--                                        tolls, parking and total in cents.
--        travel_reimbursements_waiting   view: still Submitted, for the warning.
--        mark_travel_reimbursements_paid(bigint[], date)
--                                        marks those ids Paid on that pay date,
--                                        when the payroll submittal is approved.
--      Read and called over bj-finance's own database connection, like the
--      pay table publish (migration 36): no API role may read the views or
--      call the function.
--   7. The private Storage bucket travel-reimbursements (ADR 0002): staff
--      upload to and read their own folder (<their user id>/...); Approvers
--      read everything and upload Adjustment evidence under adjustments/.
--
-- WHO MAY WRITE (Row Level Security; (select public.is_manager()) as this
-- project requires). Staff insert their own reimbursements and Lyft ride
-- reports, and update or delete their own while Submitted or Rejected. Managers
-- (which includes the owners) read every row and update any reimbursement;
-- the guard trigger refuses what the lifecycle forbids, including a manager who
-- is not an owner deciding their own or another such manager's: only an owner
-- decides a non-owner manager's (ruling 28). Only managers insert Adjustments.
--
-- OWNERS. Today an owner is a manager kept off the roster: role 'manager',
-- active = false (time-app/lib/financeAccess.ts). This file reads owners that
-- way, in guard_travel_reimbursement() and the payable view.
--
-- deal_id is the CRM's public.deals id; there is deliberately no foreign key,
-- as with shifts.deal_id: deals belong to the CRM. event_label is the Catering
-- Event as staff saw it when they chose it (staff cannot read deals).
-- ============================================================================

begin;

-- ---------- 1. mileage_rates -----------------------------------------------------
create table if not exists public.mileage_rates (
  -- The first trip date the rate applies to.
  starts_on      date          primary key,
  -- Cents per mile; may be half a cent (72.5).
  cents_per_mile numeric(6, 2) not null check (cents_per_mile > 0),
  -- The IRS announcement, e.g. 'IR-2026-29'.
  source         text          not null
);

insert into public.mileage_rates (starts_on, cents_per_mile, source) values
  ('2025-01-01', 70.00, 'IR-2024-312'),
  ('2026-01-01', 72.50, 'IR-2025-128'),
  ('2026-07-01', 76.00, 'IR-2026-29')
on conflict (starts_on) do nothing;

alter table public.mileage_rates enable row level security;
drop policy if exists "signed in read mileage rates" on public.mileage_rates;
create policy "signed in read mileage rates" on public.mileage_rates
  for select to authenticated using (true);
revoke insert, update, delete, truncate on public.mileage_rates from anon, authenticated;

-- ---------- 2. travel_reimbursements ----------------------------------------------
create table if not exists public.travel_reimbursements (
  id                     bigint generated always as identity primary key,
  profile_id             uuid        not null references public.profiles (id) on delete restrict,
  -- The Reason: Groceries / errands, or one Catering Event.
  reason_kind            text        not null,
  deal_id                bigint,
  event_label            text,
  event_date             date,
  -- "What for / where": required for errands (ruling 12), optional otherwise.
  reason_note            text,
  trip_date              date        not null,
  -- Mileage: typed, or computed from destinations by the Routes API.
  mileage_mode           text        not null,
  miles                  numeric(6, 1) not null default 0,
  stops                  jsonb,
  -- Destinations mode's checkboxes (ruling 45): the trip starts at the store,
  -- and ends at the store, unless turned off. Null when the miles are typed.
  start_at_store         boolean,
  end_at_store           boolean,
  route_legs             jsonb,
  tolls_cents            integer     not null default 0,
  parking_cents          integer     not null default 0,
  -- An Adjustment's replacement for the computed mileage amount.
  mileage_cents_override integer,
  -- Receipts: object paths in the travel-reimbursements bucket.
  receipt_paths          text[]      not null default '{}',
  -- "Are you sure there is no receipt?" answered yes (ruling 9).
  no_receipt_confirmed   boolean     not null default false,
  status                 text        not null default 'submitted',
  rejection_reason       text,
  decided_by             uuid        references public.profiles (id) on delete set null,
  decided_at             timestamptz,
  -- The pay date it was paid on, through payroll or outside it.
  paid_on                date,
  paid_by                uuid        references public.profiles (id) on delete set null,
  -- When the Receipts went to receipts@ (on approval, ruling 30).
  receipts_emailed_at    timestamptz,
  submitted_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.travel_reimbursements drop constraint if exists travel_reimbursements_status_check;
alter table public.travel_reimbursements add constraint travel_reimbursements_status_check
  check (status in ('submitted', 'approved', 'rejected', 'paid', 'paid_outside_payroll'));

alter table public.travel_reimbursements drop constraint if exists travel_reimbursements_reason_check;
alter table public.travel_reimbursements add constraint travel_reimbursements_reason_check
  check ((reason_kind = 'errands' and deal_id is null and coalesce(btrim(reason_note), '') <> '')
      or (reason_kind = 'catering_event' and deal_id is not null and coalesce(btrim(event_label), '') <> ''));

alter table public.travel_reimbursements drop constraint if exists travel_reimbursements_note_length;
alter table public.travel_reimbursements add constraint travel_reimbursements_note_length
  check (reason_note is null or length(reason_note) <= 500);

alter table public.travel_reimbursements drop constraint if exists travel_reimbursements_mileage_check;
alter table public.travel_reimbursements add constraint travel_reimbursements_mileage_check
  check (mileage_mode in ('typed', 'destinations')
     and miles >= 0 and miles <= 2000
     and (mileage_mode <> 'destinations'
          or (jsonb_typeof(stops) = 'array' and jsonb_array_length(stops) > 0
              and start_at_store is not null and end_at_store is not null
              -- Two points at least: with neither end at the store, two stops.
              and jsonb_array_length(stops) + start_at_store::int + end_at_store::int >= 2)));

alter table public.travel_reimbursements drop constraint if exists travel_reimbursements_amounts_check;
alter table public.travel_reimbursements add constraint travel_reimbursements_amounts_check
  check (tolls_cents >= 0 and parking_cents >= 0
     and (mileage_cents_override is null or mileage_cents_override >= 0)
     and (miles > 0 or tolls_cents > 0 or parking_cents > 0 or coalesce(mileage_cents_override, 0) > 0));

alter table public.travel_reimbursements drop constraint if exists travel_reimbursements_rejected_says_why;
alter table public.travel_reimbursements add constraint travel_reimbursements_rejected_says_why
  check (status <> 'rejected' or coalesce(btrim(rejection_reason), '') <> '');

alter table public.travel_reimbursements drop constraint if exists travel_reimbursements_paid_has_date;
alter table public.travel_reimbursements add constraint travel_reimbursements_paid_has_date
  check (status not in ('paid', 'paid_outside_payroll') or paid_on is not null);

create index if not exists travel_reimbursements_profile_idx
  on public.travel_reimbursements (profile_id, trip_date desc);
create index if not exists travel_reimbursements_status_idx
  on public.travel_reimbursements (status, trip_date);
create index if not exists travel_reimbursements_deal_idx
  on public.travel_reimbursements (deal_id) where deal_id is not null;

alter table public.travel_reimbursements enable row level security;

drop policy if exists "read own or approver reads all" on public.travel_reimbursements;
create policy "read own or approver reads all" on public.travel_reimbursements
  for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_manager()));

drop policy if exists "staff submit their own" on public.travel_reimbursements;
create policy "staff submit their own" on public.travel_reimbursements
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and status = 'submitted');

drop policy if exists "staff change their own while submitted or rejected" on public.travel_reimbursements;
create policy "staff change their own while submitted or rejected" on public.travel_reimbursements
  for update to authenticated
  using (profile_id = (select auth.uid()) and status in ('submitted', 'rejected'))
  with check (profile_id = (select auth.uid()) and status = 'submitted');

drop policy if exists "approvers decide" on public.travel_reimbursements;
create policy "approvers decide" on public.travel_reimbursements
  for update to authenticated
  using ((select public.is_manager()))
  with check ((select public.is_manager()));

drop policy if exists "staff delete their own while submitted or rejected" on public.travel_reimbursements;
create policy "staff delete their own while submitted or rejected" on public.travel_reimbursements
  for delete to authenticated
  using (profile_id = (select auth.uid()) and status in ('submitted', 'rejected'));

-- ---------- 3. travel_reimbursement_adjustments ------------------------------------
create table if not exists public.travel_reimbursement_adjustments (
  id               bigint generated always as identity primary key,
  reimbursement_id bigint      not null references public.travel_reimbursements (id) on delete cascade,
  field            text        not null check (field in ('mileage', 'tolls', 'parking')),
  old_cents        integer     not null check (old_cents >= 0),
  new_cents        integer     not null check (new_cents >= 0),
  note             text        not null check (btrim(note) <> '' and length(note) <= 300),
  -- Object path under adjustments/ in the bucket. Never sent to receipts@.
  evidence_path    text        not null check (evidence_path like 'adjustments/%'),
  adjusted_by      uuid        not null references public.profiles (id),
  adjusted_at      timestamptz not null default now()
);

create index if not exists travel_reimbursement_adjustments_idx
  on public.travel_reimbursement_adjustments (reimbursement_id, adjusted_at);

alter table public.travel_reimbursement_adjustments enable row level security;

drop policy if exists "read own adjustments or approver reads all" on public.travel_reimbursement_adjustments;
create policy "read own adjustments or approver reads all" on public.travel_reimbursement_adjustments
  for select to authenticated
  using ((select public.is_manager())
         or exists (select 1 from public.travel_reimbursements r
                     where r.id = reimbursement_id and r.profile_id = (select auth.uid())));

drop policy if exists "approvers adjust" on public.travel_reimbursement_adjustments;
create policy "approvers adjust" on public.travel_reimbursement_adjustments
  for insert to authenticated
  with check ((select public.is_manager()) and adjusted_by = (select auth.uid()));

revoke update, delete, truncate on public.travel_reimbursement_adjustments from anon, authenticated;

-- ---------- 4. lyft_ride_reports ----------------------------------------------------
create table if not exists public.lyft_ride_reports (
  id               bigint generated always as identity primary key,
  profile_id       uuid        not null references public.profiles (id) on delete restrict,
  reason_kind      text        not null,
  deal_id          bigint,
  event_label      text,
  event_date       date,
  reason_note      text,
  trip_date        date        not null,
  screenshot_paths text[]      not null,
  filed_at         timestamptz not null default now(),
  -- When the screenshots went to receipts@ (on upload, ruling 23).
  emailed_at       timestamptz
);

alter table public.lyft_ride_reports drop constraint if exists lyft_ride_reports_reason_check;
alter table public.lyft_ride_reports add constraint lyft_ride_reports_reason_check
  check ((reason_kind = 'errands' and deal_id is null and coalesce(btrim(reason_note), '') <> '')
      or (reason_kind = 'catering_event' and deal_id is not null and coalesce(btrim(event_label), '') <> ''));

alter table public.lyft_ride_reports drop constraint if exists lyft_ride_reports_has_screenshots;
alter table public.lyft_ride_reports add constraint lyft_ride_reports_has_screenshots
  check (cardinality(screenshot_paths) > 0);

create index if not exists lyft_ride_reports_profile_idx
  on public.lyft_ride_reports (profile_id, trip_date desc);

alter table public.lyft_ride_reports enable row level security;

drop policy if exists "read own lyft ride reports or approver reads all" on public.lyft_ride_reports;
create policy "read own lyft ride reports or approver reads all" on public.lyft_ride_reports
  for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_manager()));

drop policy if exists "staff file their own lyft ride reports" on public.lyft_ride_reports;
create policy "staff file their own lyft ride reports" on public.lyft_ride_reports
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and emailed_at is null);

revoke update, delete, truncate on public.lyft_ride_reports from anon, authenticated;

-- ---------- 5. the lifecycle in the database ------------------------------------------
-- Mirrors lib/reimbursements/lifecycle.ts. The caller is auth.uid(): null for
-- the service role and for bj-finance's own connection, which are trusted to
-- have checked who asked (the API routes check with lifecycle.ts first).
create or replace function public.guard_travel_reimbursement()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid           uuid := auth.uid();
  v_actor_manager boolean := false;
  v_actor_owner   boolean := false;
  v_subject_owner boolean;
  v_subject_mgr   boolean;
begin
  if v_uid is not null then
    select p.role = 'manager', p.role = 'manager' and not p.active
      into v_actor_manager, v_actor_owner
      from public.profiles p where p.id = v_uid;
    v_actor_manager := coalesce(v_actor_manager, false);
    v_actor_owner := coalesce(v_actor_owner, false);
  end if;

  if tg_op = 'DELETE' then
    if old.status not in ('submitted', 'rejected') then
      raise exception 'A % Travel Reimbursement cannot be deleted.', old.status;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'submitted' then
      raise exception 'A new Travel Reimbursement is Submitted.';
    end if;
    if new.decided_by is not null or new.decided_at is not null or new.paid_on is not null
       or new.paid_by is not null or new.receipts_emailed_at is not null or new.mileage_cents_override is not null then
      raise exception 'A new Travel Reimbursement carries no decision, payment or Adjustment.';
    end if;
    new.submitted_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- UPDATE
  if old.status in ('paid', 'paid_outside_payroll') then
    raise exception 'Travel Reimbursement % is Paid; Paid is final.', old.id;
  end if;
  if new.profile_id <> old.profile_id then
    raise exception 'A Travel Reimbursement cannot change hands.';
  end if;
  select p.role = 'manager' and not p.active, p.role = 'manager' and p.active
    into v_subject_owner, v_subject_mgr
    from public.profiles p where p.id = new.profile_id;
  v_subject_owner := coalesce(v_subject_owner, false);
  v_subject_mgr := coalesce(v_subject_mgr, false);

  -- The staff member themselves (not acting as an Approver) changes content
  -- and resubmits; never a decision, a payment or an Adjustment.
  if v_uid is not null and v_uid = new.profile_id and not v_actor_manager then
    if new.decided_by is distinct from old.decided_by or new.paid_on is distinct from old.paid_on
       or new.paid_by is distinct from old.paid_by or new.receipts_emailed_at is distinct from old.receipts_emailed_at
       or (new.mileage_cents_override is not null and new.mileage_cents_override is distinct from old.mileage_cents_override) then
      raise exception 'Only an Approver decides, pays or adjusts a Travel Reimbursement.';
    end if;
  end if;

  if new.status <> old.status then
    if (old.status, new.status) not in (
         ('submitted', 'approved'), ('submitted', 'rejected'), ('rejected', 'submitted'),
         ('approved', 'submitted'), ('approved', 'paid'), ('approved', 'paid_outside_payroll')) then
      raise exception 'A Travel Reimbursement cannot go from % to %.', old.status, new.status;
    end if;
    -- A decision, or sending an Approved one back: an Approver who may decide it.
    -- A non-owner manager's is decided by an owner only (ruling 28).
    if new.status in ('approved', 'rejected') or (old.status = 'approved' and new.status = 'submitted') then
      if v_uid is not null then
        if not v_actor_manager then
          raise exception 'Only an Approver (a manager or owner) can do that.';
        end if;
        if v_subject_mgr and not v_actor_owner then
          if v_uid = new.profile_id then
            raise exception 'A manager cannot decide their own Travel Reimbursement; an owner decides it.';
          end if;
          raise exception 'A manager''s Travel Reimbursement is decided by an owner, not another manager.';
        end if;
      end if;
    end if;
    if new.status = 'paid' and v_subject_owner then
      raise exception 'An owner''s Travel Reimbursement is paid outside payroll, not on the pay table.';
    end if;
    if new.status = 'paid_outside_payroll' then
      if not v_subject_owner then
        raise exception 'Only an owner''s Travel Reimbursement is paid outside payroll.';
      end if;
      if v_uid is not null and not v_actor_owner then
        raise exception 'Only an owner can mark a Travel Reimbursement Paid outside payroll.';
      end if;
    end if;
    if new.status = 'submitted' then
      new.submitted_at := now();
    end if;
  elsif old.status = 'approved' then
    -- Approved is locked: only an Adjustment's amounts and the receipts@ stamp move.
    if (new.reason_kind, new.deal_id, new.event_label, new.event_date, new.reason_note, new.trip_date,
        new.mileage_mode, new.miles, new.stops, new.start_at_store, new.end_at_store, new.route_legs, new.receipt_paths,
        new.no_receipt_confirmed)
       is distinct from
       (old.reason_kind, old.deal_id, old.event_label, old.event_date, old.reason_note, old.trip_date,
        old.mileage_mode, old.miles, old.stops, old.start_at_store, old.end_at_store, old.route_legs, old.receipt_paths,
        old.no_receipt_confirmed) then
      raise exception 'An Approved Travel Reimbursement is locked. An Approver can send it back to Submitted first.';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.guard_travel_reimbursement() from public, anon, authenticated, service_role;

drop trigger if exists guard_travel_reimbursement on public.travel_reimbursements;
create trigger guard_travel_reimbursement
  before insert or update or delete on public.travel_reimbursements
  for each row execute function public.guard_travel_reimbursement();

-- An Adjustment: on a Submitted or Approved reimbursement, by an Approver who
-- may decide it (lifecycle.ts approverAction 'adjust'): a non-owner manager's
-- only by an owner (ruling 28).
create or replace function public.guard_travel_reimbursement_adjustment()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_status  text;
  v_subject uuid;
  v_manager boolean;
  v_owner   boolean;
  v_subject_mgr boolean;
begin
  select r.status, r.profile_id into v_status, v_subject
    from public.travel_reimbursements r where r.id = new.reimbursement_id;
  if v_status not in ('submitted', 'approved') then
    raise exception 'An Adjustment can only be made while a Travel Reimbursement is Submitted or Approved.';
  end if;
  if v_uid is not null then
    select p.role = 'manager', p.role = 'manager' and not p.active into v_manager, v_owner
      from public.profiles p where p.id = v_uid;
    if not coalesce(v_manager, false) then
      raise exception 'Only an Approver (a manager or owner) can make an Adjustment.';
    end if;
    select p.role = 'manager' and p.active into v_subject_mgr
      from public.profiles p where p.id = v_subject;
    if coalesce(v_subject_mgr, false) and not coalesce(v_owner, false) then
      if v_uid = v_subject then
        raise exception 'A manager cannot adjust their own Travel Reimbursement; an owner decides it.';
      end if;
      raise exception 'A manager''s Travel Reimbursement is adjusted by an owner, not another manager.';
    end if;
  end if;
  new.adjusted_at := now();
  return new;
end;
$$;

revoke execute on function public.guard_travel_reimbursement_adjustment() from public, anon, authenticated, service_role;

drop trigger if exists guard_travel_reimbursement_adjustment on public.travel_reimbursement_adjustments;
create trigger guard_travel_reimbursement_adjustment
  before insert on public.travel_reimbursement_adjustments
  for each row execute function public.guard_travel_reimbursement_adjustment();

-- ---------- 6. the payroll seam -------------------------------------------------------
-- What the pay table pays: every Approved reimbursement of payroll staff not
-- yet Paid, whatever its trip date (ruling 22). Owners are left out: theirs
-- are paid outside payroll (18). Mileage is miles x the rate in effect on the
-- trip date, half-up to the cent (Postgres round() on numeric rounds half away
-- from zero), unless an Adjustment replaced it; lib/reimbursements/money.ts is
-- the app's copy. mileage_cents and total_cents are null when no rate covers
-- the trip date: the build should flag that, not pay it.
create or replace view public.travel_reimbursements_payable as
select r.id,
       r.profile_id,
       p.qbo_employee_id,
       p.full_name,
       r.trip_date,
       r.miles,
       rate.cents_per_mile,
       coalesce(r.mileage_cents_override, round(r.miles * rate.cents_per_mile)::integer) as mileage_cents,
       r.tolls_cents,
       r.parking_cents,
       coalesce(r.mileage_cents_override, round(r.miles * rate.cents_per_mile)::integer)
         + r.tolls_cents + r.parking_cents as total_cents,
       r.decided_at as approved_at
  from public.travel_reimbursements r
  join public.profiles p on p.id = r.profile_id
  left join lateral (
    select m.cents_per_mile
      from public.mileage_rates m
     where m.starts_on <= r.trip_date
     order by m.starts_on desc
     limit 1
  ) rate on true
 where r.status = 'approved'
   and not (p.role = 'manager' and p.active = false);

-- Still waiting for an Approver: the build warns, never blocks (ruling 22).
create or replace view public.travel_reimbursements_waiting as
select r.id,
       r.profile_id,
       p.full_name,
       (p.role = 'manager' and p.active = false) as is_owner,
       r.trip_date,
       r.submitted_at
  from public.travel_reimbursements r
  join public.profiles p on p.id = r.profile_id
 where r.status = 'submitted';

revoke all on public.travel_reimbursements_payable, public.travel_reimbursements_waiting from public, anon, authenticated;

-- Mark the reimbursements a payroll run paid, when its submittal is approved.
-- All or nothing: every id must be an Approved reimbursement of payroll staff,
-- or nothing is marked and the error names the first that is not. An id
-- already Paid on the same pay date is skipped, so a retry is harmless.
-- Returns how many were marked now.
create or replace function public.mark_travel_reimbursements_paid(p_ids bigint[], p_pay_date date)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_bad bigint;
  v_n   integer;
begin
  if p_pay_date is null then
    raise exception 'A pay date is required.';
  end if;
  select x.id into v_bad
    from unnest(coalesce(p_ids, '{}'::bigint[])) as x(id)
    left join public.travel_reimbursements r on r.id = x.id
    left join public.profiles p on p.id = r.profile_id
   where r.id is null
      or (p.role = 'manager' and p.active = false)
      or not (r.status = 'approved' or (r.status = 'paid' and r.paid_on = p_pay_date))
   limit 1;
  if v_bad is not null then
    raise exception 'Travel Reimbursement % is not an Approved reimbursement of payroll staff; nothing was marked Paid.', v_bad;
  end if;
  update public.travel_reimbursements
     set status = 'paid', paid_on = p_pay_date
   where id = any (p_ids) and status = 'approved';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.mark_travel_reimbursements_paid(bigint[], date) from public, anon, authenticated, service_role;

commit;

-- ---------- 7. Storage: the private bucket for reimbursement files ----------------------
-- Separate transaction, as in supabase/crm/001_call_desk.sql: storage.* is
-- Supabase-managed and worth isolating if the SQL editor's role lacks a grant.
-- Paths: <user id>/receipts/..., <user id>/lyft/... (staff, their own) and
-- adjustments/<reimbursement id>/... (Approvers' evidence, never emailed).

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('travel-reimbursements', 'travel-reimbursements', false, 15728640,  -- 15 MB
        array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

drop policy if exists "staff upload their own travel reimbursement files" on storage.objects;
create policy "staff upload their own travel reimbursement files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'travel-reimbursements'
              and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "approvers upload adjustment evidence" on storage.objects;
create policy "approvers upload adjustment evidence" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'travel-reimbursements'
              and (storage.foldername(name))[1] = 'adjustments'
              and (select public.is_manager()));

drop policy if exists "read own travel reimbursement files or approver reads all" on storage.objects;
create policy "read own travel reimbursement files or approver reads all" on storage.objects
  for select to authenticated
  using (bucket_id = 'travel-reimbursements'
         and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_manager())));

commit;
