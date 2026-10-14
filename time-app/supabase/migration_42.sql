-- ============================================================================
-- Withers Time, migration 42: the owner role
-- Run once in the Supabase SQL editor, after migration_40.sql. Safe to re-run.
-- Written as migration 31 (PR #44) and renumbered 42 when main had reached 40
-- (41 is held by another open PR and is independent of this file): it must
-- run after migration 37, whose travel-reimbursement guard it widens (step 7).
--
-- VERIFY. supabase/migration_42_verify.sql. ROLLBACK. supabase/migration_42_down.sql.
--
-- APPLY ORDER. Deploy both apps (crm and time) FIRST, then run this file,
-- promptly.
--   * New code, old database: nobody has the owner role yet, so the
--     personal-finance pages (/money, /dial, /safe) refuse everyone until this
--     file runs. Every manager gate works as before. Nothing else changes.
--   * Old code, new database: the old code only lets role = 'manager' through,
--     so the two owners would be shut out of the CRM and the time app's
--     manager pages until the new code deploys. Do not run this file first.
--
-- WHAT THIS DOES
--   1. Refuses to run if any RLS policy in the database tests role = 'manager'
--      itself instead of calling is_manager(). Such a policy would stop
--      letting the owners in the moment their role changes. (None exist in
--      this repository; this covers tables created elsewhere.)
--   2. profiles.role may now be 'owner', 'manager' or 'employee'.
--   3. public.is_owner(): true only for an owner. Same shape as is_manager().
--   4. public.is_manager() is now true for owners as well as managers, so an
--      owner keeps every manager policy in the database without any policy
--      being edited.
--   5. guard_owner_profiles(), BEFORE INSERT/UPDATE/DELETE on profiles: a
--      signed-in person who is not an owner cannot create an owner, give or
--      take away the owner role, or change or delete an owner's row. Managers
--      reach every profile through profiles_manager_all, so without this the
--      Team page's API would be the only thing stopping them.
--   6. The two owners, keyed on their login emails, become 'owner'. If either
--      account is missing the whole file rolls back rather than leave one
--      owner in place.
--   7. Migration 37's travel-reimbursement guard, adjustment guard, payroll
--      views and mark-paid function read an owner as role 'manager' and not
--      active. Each is redefined unchanged except that role 'manager' there
--      now reads role in ('manager', 'owner'), as lib/reimbursements/
--      lifecycle.ts already does. Without this the owners could not approve
--      or adjust a reimbursement once their role is 'owner', and theirs would
--      land on the pay table instead of being paid outside payroll.
--
-- NOT CHANGED. `active` still means "on the staff roster" and still plays no
-- part in access (audit H2); the owners stay off the roster.
--
-- (select public.is_owner()) and (select public.is_manager()) are wrapped in
-- scalar subqueries: a bare call is re-evaluated per row and has caused
-- statement timeouts in this project (crm/004).
-- ============================================================================

begin;

-- ---------- 1. no policy may test the role by hand ---------------------------
do $$
declare
  offenders text;
begin
  select string_agg(format('%I.%I policy %I', schemaname, tablename, policyname), ', ')
    into offenders
    from pg_policies
   where coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '''manager''';
  if offenders is not null then
    raise exception 'migration 42: these policies test role = ''manager'' directly and would shut the owners out once their role is ''owner'': %. Rewrite them to use (select public.is_manager()) first.', offenders;
  end if;
end $$;

-- ---------- 2. the role column ------------------------------------------------
-- migration.sql declared the check inline, so its name is whatever Postgres
-- chose (profiles_role_check). Drop every CHECK on profiles that mentions the
-- role column, whatever it is called, and put back one with a known name.
do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ~ '\mrole\M'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles add constraint profiles_role_check
  check (role in ('owner', 'manager', 'employee'));

-- ---------- 3 and 4. the helpers ---------------------------------------------
create or replace function public.is_owner()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'owner'
  );
$$;

-- An owner is a manager for every manager policy in both apps.
create or replace function public.is_manager()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('manager', 'owner')
  );
$$;

-- ---------- 5. managers cannot touch the owner role --------------------------
-- Only a request running as the API's signed-in role is checked. The service
-- role (the invite route's upsert, offboarding), the SQL editor and SECURITY
-- DEFINER code are trusted, as in migration 30's claim guard. The invite and
-- re-invite routes refuse a manager themselves before they reach the service
-- role (lib/roles.ts).
create or replace function public.guard_owner_profiles()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user <> 'authenticated' or (select public.is_owner()) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if new.role = 'owner' then
      raise exception 'Only an owner can make someone an owner'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.role = 'owner' then
      raise exception 'Only an owner can remove an owner'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  -- UPDATE
  if old.role = 'owner' and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'Only an owner can change an owner''s account'
      using errcode = 'insufficient_privilege';
  end if;
  if new.role = 'owner' and old.role is distinct from 'owner' then
    raise exception 'Only an owner can make someone an owner'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function public.guard_owner_profiles() is
  'BEFORE INSERT/UPDATE/DELETE on profiles: a signed-in non-owner cannot create, promote to, demote from, edit or delete an owner. Migration 42.';

revoke execute on function public.guard_owner_profiles() from public, anon, authenticated, service_role;

drop trigger if exists profiles_owner_guard on public.profiles;
create trigger profiles_owner_guard
  before insert or update or delete on public.profiles
  for each row execute function public.guard_owner_profiles();

-- ---------- 6. the owners -----------------------------------------------------
-- Their login emails are business addresses. `active` is left as it is.
do $$
declare
  missing text;
begin
  select string_agg(e, ', ')
    into missing
    from unnest(array['alina@withers-ventures.com', 'alex@withers-ventures.com']) as e
   where not exists (
     select 1 from auth.users u join public.profiles p on p.id = u.id
      where lower(u.email) = e
   );
  if missing is not null then
    raise exception 'migration 42: no profile for %. Nothing was changed.', missing;
  end if;

  update public.profiles p
     set role = 'owner'
    from auth.users u
   where u.id = p.id
     and lower(u.email) in ('alina@withers-ventures.com', 'alex@withers-ventures.com');
end $$;

-- ---------- 7. migration 37 reads the owner role -----------------------------
-- Migration 37's text, with role = 'manager' read as role in ('manager',
-- 'owner') and nothing else changed. The triggers already point at these
-- functions by name, so they are not recreated.
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
    select p.role in ('manager', 'owner'), p.role in ('manager', 'owner') and not p.active
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
  select p.role in ('manager', 'owner') and not p.active, p.role in ('manager', 'owner') and p.active
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
    select p.role in ('manager', 'owner'), p.role in ('manager', 'owner') and not p.active into v_manager, v_owner
      from public.profiles p where p.id = v_uid;
    if not coalesce(v_manager, false) then
      raise exception 'Only an Approver (a manager or owner) can make an Adjustment.';
    end if;
    select p.role in ('manager', 'owner') and p.active into v_subject_mgr
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
   and not (p.role in ('manager', 'owner') and p.active = false);

-- Still waiting for an Approver: the build warns, never blocks (ruling 22).
create or replace view public.travel_reimbursements_waiting as
select r.id,
       r.profile_id,
       p.full_name,
       (p.role in ('manager', 'owner') and p.active = false) as is_owner,
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
      or (p.role in ('manager', 'owner') and p.active = false)
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
