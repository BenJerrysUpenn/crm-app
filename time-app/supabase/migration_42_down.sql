-- ============================================================================
-- Withers Time, rollback for migration 42 (the owner role)
--
-- Every owner goes back to 'manager' (what the two owners were before), the
-- owner guard and is_owner() are dropped, is_manager() goes back to testing
-- role = 'manager' only, the role CHECK goes back to manager/employee, and
-- migration 37's travel-reimbursement functions and views go back to reading
-- an owner as role 'manager' and not active.
--
-- WITH THE NEW CODE STILL LIVE. Every manager gate keeps working (a manager
-- is still a manager), but nobody is an owner any more, so the
-- personal-finance pages (/money, /dial, /safe) refuse everyone. Roll the CRM
-- back too if those pages are needed, or re-run migration_42.sql.
--
-- DATA LOST: none. Roles change from 'owner' to 'manager'; nothing else.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

begin;

drop trigger if exists profiles_owner_guard on public.profiles;
drop function if exists public.guard_owner_profiles();

update public.profiles set role = 'manager' where role = 'owner';

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('manager', 'employee'));

create or replace function public.is_manager()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'manager'
  );
$$;

drop function if exists public.is_owner();

-- Migration 37's text as it was before migration 42.
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
  -- and resubmits; never a decision or a payment.
  if v_uid is not null and v_uid = new.profile_id and not v_actor_manager then
    if new.decided_by is distinct from old.decided_by or new.paid_on is distinct from old.paid_on
       or new.paid_by is distinct from old.paid_by or new.receipts_emailed_at is distinct from old.receipts_emailed_at then
      raise exception 'Only an Approver decides or pays a Travel Reimbursement.';
    end if;
  end if;

  -- The amounts an Adjustment changes. The staff member's own edit while
  -- Submitted or Rejected may retype tolls and parking and drops a Mileage
  -- Adjustment (back to null). Any other change to them is an Adjustment: on
  -- a Submitted or Approved one, leaving its status, by an Approver who may
  -- decide it; a non-owner manager's only by an owner (rulings 28, 29).
  if v_uid is not null
     and (new.tolls_cents, new.parking_cents, new.mileage_cents_override)
         is distinct from (old.tolls_cents, old.parking_cents, old.mileage_cents_override)
     and not (v_uid = new.profile_id and old.status in ('submitted', 'rejected')
              and (new.mileage_cents_override is null
                   or new.mileage_cents_override is not distinct from old.mileage_cents_override)) then
    if new.status <> old.status or old.status not in ('submitted', 'approved') then
      raise exception 'An Adjustment can only be made while a Travel Reimbursement is Submitted or Approved.';
    end if;
    if not v_actor_manager then
      raise exception 'Only an Approver (a manager or owner) can make an Adjustment.';
    end if;
    if v_subject_mgr and not v_actor_owner then
      if v_uid = new.profile_id then
        raise exception 'A manager cannot adjust their own Travel Reimbursement; an owner decides it.';
      end if;
      raise exception 'A manager''s Travel Reimbursement is adjusted by an owner, not another manager.';
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
