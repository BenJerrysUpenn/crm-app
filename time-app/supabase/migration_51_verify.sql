-- ============================================================================
-- Withers Time, verification for migration 51 (cash count reminders in Slack)
--
-- Run by hand against a database with migration 51 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs one employee in public.profiles.
-- A clean run ends with "migration 51 verified".
--
-- WHAT IS CHECKED
--   1. One reminder per store day per kind: a second 'open' row for the same
--      day is refused (23505); a 'close' row the same day and an 'open' row
--      the next day are not.
--   2. The follow-up claim is once: the update guarded on followup_outcome is
--      null takes the row the first time and nothing the second.
--   3. The checks: an unknown kind, source or outcome is refused; so is a row
--      naming nobody, or a Slack id list that does not line up with the
--      people.
--   4. Nobody signed in reads or writes the table; anon and authenticated hold
--      no privileges on it; the service role does.
-- ============================================================================

begin;

do $$
declare
  emp     uuid;
  r_open  bigint;
  n       integer;
  refused boolean;
begin
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if emp is null then raise exception 'need one employee in profiles to run this file'; end if;

  -- ---- 1. one per day per kind --------------------------------------------------------------
  insert into public.cash_count_reminders (store_date, kind, profile_ids, slack_user_ids, channel_id)
    values ('2030-01-02', 'open', array[emp], array['U0TEST'], 'C0TEST') returning id into r_open;
  begin
    insert into public.cash_count_reminders (store_date, kind, profile_ids, slack_user_ids, channel_id)
      values ('2030-01-02', 'open', array[emp], array['U0TEST'], 'C0TEST');
    refused := false;
  exception when unique_violation then
    refused := true;
  end;
  if not refused then raise exception 'a second open reminder for one day was accepted'; end if;
  insert into public.cash_count_reminders (store_date, kind, profile_ids, slack_user_ids, channel_id)
    values ('2030-01-02', 'close', array[emp], array[''], 'C0TEST');
  insert into public.cash_count_reminders (store_date, kind, profile_ids, slack_user_ids, channel_id)
    values ('2030-01-03', 'open', array[emp], array['U0TEST'], 'C0TEST');

  -- ---- 2. the follow-up claim is once ---------------------------------------------------------
  update public.cash_count_reminders set followup_outcome = 'sending'
   where id = r_open and followup_outcome is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'the first follow-up claim took % rows', n; end if;
  update public.cash_count_reminders set followup_outcome = 'sending'
   where id = r_open and followup_outcome is null;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'the second follow-up claim took % rows', n; end if;

  -- ---- 3. the checks --------------------------------------------------------------------------
  begin
    insert into public.cash_count_reminders (store_date, kind, profile_ids, slack_user_ids, channel_id)
      values ('2030-01-04', 'midday', array[emp], array['U0TEST'], 'C0TEST');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an unknown kind was accepted'; end if;
  begin
    update public.cash_count_reminders set reminder_source = 'template' where id = r_open;
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an unknown reminder_source was accepted'; end if;
  begin
    update public.cash_count_reminders set followup_outcome = 'maybe' where id = r_open;
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an unknown followup_outcome was accepted'; end if;
  begin
    insert into public.cash_count_reminders (store_date, kind, profile_ids, slack_user_ids, channel_id)
      values ('2030-01-05', 'open', array[]::uuid[], array[]::text[], 'C0TEST');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'a reminder naming nobody was accepted'; end if;
  begin
    insert into public.cash_count_reminders (store_date, kind, profile_ids, slack_user_ids, channel_id)
      values ('2030-01-05', 'open', array[emp], array['U0A', 'U0B'], 'C0TEST');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'Slack ids that do not line up with the people were accepted'; end if;

  -- ---- 4. the service role alone --------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    select count(*) into n from public.cash_count_reminders;
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a signed-in user can read cash_count_reminders'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if has_table_privilege('anon', 'public.cash_count_reminders', 'select')
     or has_table_privilege('anon', 'public.cash_count_reminders', 'insert')
     or has_table_privilege('authenticated', 'public.cash_count_reminders', 'select')
     or has_table_privilege('authenticated', 'public.cash_count_reminders', 'update') then
    raise exception 'anon or authenticated holds privileges on cash_count_reminders';
  end if;
  if not has_table_privilege('service_role', 'public.cash_count_reminders', 'insert') then
    raise exception 'service_role cannot insert into cash_count_reminders';
  end if;

  raise notice 'migration 51 verified';
end $$;

rollback;
