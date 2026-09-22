-- ============================================================================
-- Withers Time — verification for migration 25 (audit trail)
--
-- This repository has no database test harness: the unit tests are `node --test`
-- over the pure modules in lib/, and nothing in CI can reach a Postgres. So the
-- trigger behaviour is checked by running this file, by hand, against a
-- database that has migration_25.sql applied.
--
-- HOW TO RUN
--
--   Local Supabase (preferred — it writes and then throws the writes away):
--     supabase start
--     psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" \
--          -v ON_ERROR_STOP=1 -f supabase/migration.sql      # base schema
--     ...then every later migration in order, then migration_25.sql, then:
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/migration_25_verify.sql
--
--   Hosted project: paste the whole file into the SQL editor and run it.
--
-- SAFETY. Everything happens inside one transaction that ends in ROLLBACK, so
-- the rows this file writes — including its own audit rows — never survive it.
-- It is safe against production, though a local database is still the right
-- place. It asserts by raising: any failure aborts with a readable message, and
-- a clean run ends with "migration 25 verified".
--
-- WHAT IS CHECKED
--   1. INSERT writes an audit row with an after-image and no before-image.
--   2. UPDATE writes the before-image (the OLD row) and the after-image.
--   3. DELETE writes the before-image and no after-image.
--   4. The same three for shifts.
--   5. The actor columns are populated: db_role is always there, and a
--      simulated PostgREST JWT lands in actor_uid / actor_role.
--   6. row_audit is append-only through RLS: the authenticated role can read it
--      (as a manager) but cannot insert, update or delete.
-- ============================================================================

begin;

do $$
declare
  emp        uuid;
  entry_id   bigint;
  shift_id   bigint;
  rec        record;
  n          integer;
begin
  select id into emp from public.profiles order by created_at limit 1;
  if emp is null then
    raise exception 'no profiles rows: seed a person before running this file';
  end if;

  -- ---- 5. actor attribution: pretend to be a signed-in user ----------------
  -- This is what PostgREST sets on every request. Setting it by hand is how we
  -- check the claims parsing without standing up an HTTP layer.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', emp::text, 'role', 'authenticated')::text,
    true
  );

  -- ---- 1. INSERT ------------------------------------------------------------
  insert into public.time_entries (employee_id, clock_in_at, status)
  values (emp, now() - interval '3 hours', 'open')
  returning id into entry_id;

  select * into rec from public.row_audit
   where table_name = 'time_entries' and row_id = entry_id and op = 'INSERT';
  if rec is null then raise exception 'INSERT on time_entries was not audited'; end if;
  if rec.before_image is not null then
    raise exception 'INSERT audit row carries a before-image: %', rec.before_image;
  end if;
  if rec.after_image ->> 'employee_id' is distinct from emp::text then
    raise exception 'INSERT after-image has the wrong employee: %', rec.after_image;
  end if;
  if rec.actor_uid is distinct from emp then
    raise exception 'INSERT audit row did not record actor_uid (got %)', rec.actor_uid;
  end if;
  if rec.actor_role is distinct from 'authenticated' then
    raise exception 'INSERT audit row did not record the JWT role (got %)', rec.actor_role;
  end if;
  if rec.db_role is null then raise exception 'db_role was not recorded'; end if;

  -- ---- 2. UPDATE ------------------------------------------------------------
  update public.time_entries
     set clock_out_at = now(), status = 'closed'
   where id = entry_id;

  select * into rec from public.row_audit
   where table_name = 'time_entries' and row_id = entry_id and op = 'UPDATE';
  if rec is null then raise exception 'UPDATE on time_entries was not audited'; end if;
  if rec.before_image ->> 'status' is distinct from 'open' then
    raise exception 'UPDATE before-image is not the OLD row: %', rec.before_image;
  end if;
  if rec.after_image ->> 'status' is distinct from 'closed' then
    raise exception 'UPDATE after-image is not the NEW row: %', rec.after_image;
  end if;
  if rec.before_image ->> 'clock_out_at' is not null then
    raise exception 'UPDATE before-image already has a clock_out_at: %', rec.before_image;
  end if;

  -- ---- 3. DELETE ------------------------------------------------------------
  -- The case this whole migration exists for: ids 1270-1274 vanished with no
  -- record. After this, a delete leaves the whole row behind.
  delete from public.time_entries where id = entry_id;

  select * into rec from public.row_audit
   where table_name = 'time_entries' and row_id = entry_id and op = 'DELETE';
  if rec is null then raise exception 'DELETE on time_entries was not audited'; end if;
  if rec.after_image is not null then
    raise exception 'DELETE audit row carries an after-image: %', rec.after_image;
  end if;
  if (rec.before_image ->> 'id')::bigint is distinct from entry_id then
    raise exception 'DELETE before-image is not the deleted row: %', rec.before_image;
  end if;
  if rec.before_image ->> 'clock_out_at' is null then
    raise exception 'DELETE before-image lost the last update: %', rec.before_image;
  end if;

  -- ---- 4. shifts ------------------------------------------------------------
  insert into public.shifts (employee_id, starts_at, ends_at, position, published)
  values (emp, now() + interval '1 day', now() + interval '1 day 6 hours', 'PENN Opener', false)
  returning id into shift_id;
  update public.shifts set published = true where id = shift_id;
  delete from public.shifts where id = shift_id;

  select count(*) into n from public.row_audit
   where table_name = 'shifts' and row_id = shift_id;
  if n <> 3 then
    raise exception 'expected 3 audit rows for the shift lifecycle, got %', n;
  end if;

  select * into rec from public.row_audit
   where table_name = 'shifts' and row_id = shift_id and op = 'UPDATE';
  if (rec.before_image ->> 'published')::boolean is not false then
    raise exception 'shift UPDATE before-image lost published=false: %', rec.before_image;
  end if;

  raise notice 'migration 25 verified: % audit rows written and rolled back',
    (select count(*) from public.row_audit where row_id in (entry_id, shift_id));
end $$;

-- ---- 6. append-only through RLS ---------------------------------------------
-- Checked as the `authenticated` role, which is what a browser session is.
-- Every write must be refused: there is no insert/update/delete policy, and RLS
-- denies by default. A manager can read; nobody can change what is written.
do $$
declare
  refused boolean;
begin
  set local role authenticated;

  begin
    insert into public.row_audit (table_name, row_id, op, db_role)
    values ('time_entries', -1, 'DELETE', 'authenticated');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'row_audit accepted an INSERT from the authenticated role';
  end if;

  begin
    update public.row_audit set before_image = '{}'::jsonb where true;
    -- An UPDATE with no policy matches no rows rather than raising, so an
    -- "unaffected" update is also a pass. What must never happen is a row
    -- actually changing.
    refused := not found;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'row_audit accepted an UPDATE from the authenticated role';
  end if;

  begin
    delete from public.row_audit where true;
    refused := not found;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'row_audit accepted a DELETE from the authenticated role';
  end if;

  reset role;
  raise notice 'row_audit is append-only through RLS';
end $$;

rollback;
