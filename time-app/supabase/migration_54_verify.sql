-- ============================================================================
-- Withers Time, verification for migration 54 (cake order packing reminders)
--
-- Run by hand against a database with migration 54 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs one employee in public.profiles.
-- A clean run ends with "migration 54 verified".
--
-- WHAT IS CHECKED
--   1. One post per order: a second row for the same order_key is refused
--      (23505); a row for another order is not.
--   2. The follow-up claim is once: the update guarded on followup_outcome is
--      null takes the row the first time and nothing the second.
--   3. The checks: an unknown source, outcome or packed_how is refused, and so
--      is packed_how on an order not marked not_needed; so is a row naming
--      nobody, or a Slack id list that does not line up with the people.
--   4. Nobody signed in reads or writes the table; anon and authenticated hold
--      no privileges on it; the service role does.
-- ============================================================================

begin;

do $$
declare
  emp     uuid;
  r_one   bigint;
  n       integer;
  refused boolean;
begin
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if emp is null then raise exception 'need one employee in profiles to run this file'; end if;

  -- ---- 1. one post per order ----------------------------------------------------------------
  insert into public.cake_order_reminders (order_key, message_id, received_at, profile_ids, slack_user_ids, channel_id)
    values ('TEST-1', '<m1@example.test>', '2030-01-02 15:00+00', array[emp], array['U0TEST'], 'C0TEST') returning id into r_one;
  begin
    insert into public.cake_order_reminders (order_key, message_id, received_at, profile_ids, slack_user_ids, channel_id)
      values ('TEST-1', '<m1b@example.test>', '2030-01-02 15:01+00', array[emp], array['U0TEST'], 'C0TEST');
    refused := false;
  exception when unique_violation then
    refused := true;
  end;
  if not refused then raise exception 'a second post for one order was accepted'; end if;
  insert into public.cake_order_reminders (order_key, message_id, received_at, profile_ids, slack_user_ids, channel_id)
    values ('TEST-2', '<m2@example.test>', '2030-01-02 16:00+00', array[emp], array[''], 'C0TEST');

  -- ---- 2. the follow-up claim is once ---------------------------------------------------------
  update public.cake_order_reminders set followup_outcome = 'sending'
   where id = r_one and followup_outcome is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'the first follow-up claim took % rows', n; end if;
  update public.cake_order_reminders set followup_outcome = 'sending'
   where id = r_one and followup_outcome is null;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'the second follow-up claim took % rows', n; end if;

  -- ---- 3. the checks --------------------------------------------------------------------------
  begin
    update public.cake_order_reminders set post_source = 'template' where id = r_one;
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an unknown post_source was accepted'; end if;
  begin
    update public.cake_order_reminders set followup_outcome = 'maybe' where id = r_one;
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an unknown followup_outcome was accepted'; end if;
  begin
    update public.cake_order_reminders set packed_how = 'reaction' where id = r_one;
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'packed_how on an order still being followed up was accepted'; end if;
  update public.cake_order_reminders set followup_outcome = 'not_needed', packed_how = 'reaction' where order_key = 'TEST-2';
  begin
    update public.cake_order_reminders set packed_how = 'emoji' where order_key = 'TEST-2';
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an unknown packed_how was accepted'; end if;
  begin
    insert into public.cake_order_reminders (order_key, message_id, received_at, profile_ids, slack_user_ids, channel_id)
      values ('TEST-3', '<m3@example.test>', '2030-01-02 17:00+00', array[]::uuid[], array[]::text[], 'C0TEST');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'a post naming nobody was accepted'; end if;
  begin
    insert into public.cake_order_reminders (order_key, message_id, received_at, profile_ids, slack_user_ids, channel_id)
      values ('TEST-3', '<m3@example.test>', '2030-01-02 17:00+00', array[emp], array['U0A', 'U0B'], 'C0TEST');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'Slack ids that do not line up with the people were accepted'; end if;

  -- ---- 4. the service role alone --------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    select count(*) into n from public.cake_order_reminders;
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a signed-in user can read cake_order_reminders'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if has_table_privilege('anon', 'public.cake_order_reminders', 'select')
     or has_table_privilege('anon', 'public.cake_order_reminders', 'insert')
     or has_table_privilege('authenticated', 'public.cake_order_reminders', 'select')
     or has_table_privilege('authenticated', 'public.cake_order_reminders', 'update') then
    raise exception 'anon or authenticated holds privileges on cake_order_reminders';
  end if;
  if not has_table_privilege('service_role', 'public.cake_order_reminders', 'insert') then
    raise exception 'service_role cannot insert into cake_order_reminders';
  end if;

  raise notice 'migration 54 verified';
end $$;

rollback;
