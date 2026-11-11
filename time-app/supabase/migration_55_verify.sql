-- ============================================================================
-- Withers Time, verification for migration 55 (the schedulers' availability
-- email claim's WHERE clause — bj-finance #834).
--
-- Run by hand against a database with migration 55 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs two employees in
-- public.profiles. A clean run ends with "migration 55 verified". Every date
-- below is invented, so real queued notices on a live database are back,
-- untouched, after the ROLLBACK (the claim takes the whole queue, so on a live
-- database it is exercised only on a day long past, restored by the ROLLBACK).
--
-- WHAT IS CHECKED
--   1. THE GUARD (#834). The service-role safe-update guard (pg-safeupdate)
--      rejects any DELETE whose statement has no WHERE of its own — that is
--      what raised "DELETE requires a WHERE clause" on every cron run against
--      migration 48's "delete ... using fresh returning ...". The extension is
--      not present in this throwaway Postgres, so its rule is applied here to
--      the body the catalog actually holds: every DELETE in
--      claim_availability_digest must carry a WHERE before its RETURNING. The
--      rule, not one phrasing, is checked, so reformatting the body or choosing
--      a different WHERE does not fail it; dropping the WHERE does. Only the
--      DELETE's own WHERE counts, as with the guard: comments, string literals
--      and anything in parentheses (a subquery in USING, a CTE) are set aside
--      first, so "-- where" or "using (select ... where ...)" does not pass.
--   2. BEHAVIOUR UNCHANGED. The first claim of a day takes every queued notice
--      once and records the day; a second claim the same day returns nothing;
--      a notice queued after that day's email waits for the next day's; rows
--      over 60 days older than the day are pruned. (The WHERE deletes exactly
--      what the old USING cross-join did, so the once-a-day contract holds.)
--   3. GRANTS UNCHANGED. Only the service role may execute the claim.
-- ============================================================================

begin;

do $$
declare
  emp     uuid;
  other   uuid;
  v_day   date := date '2017-03-15';
  n       integer;
  src     text;
  stmt    text;
  prev    text;
  deletes integer := 0;
  -- what the check counts as a DELETE statement, everywhere it looks for one
  del_re  constant text := '\mdelete\s+from\M';
begin
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  select id into other from public.profiles where role = 'employee' and id <> emp order by created_at limit 1;
  if emp is null or other is null then
    raise exception 'need two employees in profiles to run this file';
  end if;

  -- ---- 1. the guard: pg-safeupdate's rule, every DELETE carries its own WHERE ----------
  select lower(p.prosrc) into src from pg_proc p
   where p.oid = 'public.claim_availability_digest(date)'::regprocedure;
  -- the guard reads the parsed statement, so comments and literals say nothing
  src := regexp_replace(src, '--[^\n]*', ' ', 'g');
  src := regexp_replace(src, '/\*.*?\*/', ' ', 'g');
  src := regexp_replace(src, '''([^'']|'''')*''', ' ', 'g');
  n := (select count(*) from regexp_matches(src, del_re, 'g'));
  -- set aside every parenthesised group, innermost first: a WHERE in a subquery
  -- or CTE is not the DELETE's own WHERE
  loop
    prev := src;
    src := regexp_replace(src, '\([^()]*\)', ' ', 'g');
    exit when src = prev;
  end loop;
  if n <> (select count(*) from regexp_matches(src, del_re, 'g')) then
    raise exception 'claim_availability_digest has a DELETE inside parentheses (a subquery or CTE) that this check cannot hold to the safe-update guard';
  end if;
  for stmt in select s from regexp_split_to_table(src, ';') s where s ~ del_re loop
    deletes := deletes + 1;
    -- the DELETE's own clauses run from "delete from" to its RETURNING (or the end)
    stmt := split_part(substring(stmt from del_re || '(.*)$'), 'returning', 1);
    if stmt !~ '\mwhere\M' then
      raise exception 'claim_availability_digest has a DELETE with no WHERE — the safe-update guard rejects it (#834): delete from%', stmt;
    end if;
  end loop;
  if deletes = 0 then
    raise exception 'found no DELETE in claim_availability_digest to hold to the safe-update guard';
  end if;

  -- ---- 2. the first claim takes the whole queue once a day ---------------------------
  insert into public.availability_notices (employee_id, changed_date) values (emp, v_day + 5);
  insert into public.availability_notices (employee_id, changed_weekday) values (other, 2);

  set local role service_role;
  select count(*) into n from public.claim_availability_digest(v_day) c
   where (c.employee_id = emp and c.changed_date = v_day + 5) or (c.employee_id = other and c.changed_weekday = 2);
  reset role;
  if n <> 2 then raise exception 'the first availability claim returned % of 2 notices', n; end if;
  select count(*) into n from public.availability_notices;
  if n <> 0 then raise exception 'claimed availability notices are still queued'; end if;
  if not exists (select 1 from public.availability_digests where digest_day = v_day) then
    raise exception 'the availability claim did not record the day';
  end if;

  -- a second claim the same day takes nothing; a change queued after waits for tomorrow
  insert into public.availability_notices (employee_id, changed_weekday) values (emp, 4);
  set local role service_role;
  select count(*) into n from public.claim_availability_digest(v_day);
  reset role;
  if n <> 0 then raise exception 'a second availability claim the same day returned % notices', n; end if;
  select count(*) into n from public.availability_notices where employee_id = emp and changed_weekday = 4;
  if n <> 1 then raise exception 'an availability notice queued after the day''s email did not wait'; end if;
  set local role service_role;
  select count(*) into n from public.claim_availability_digest(v_day + 1) c where c.employee_id = emp and c.changed_weekday = 4;
  reset role;
  if n <> 1 then raise exception 'the next day''s availability claim did not return the waiting notice'; end if;

  -- rows more than 60 days older than the day are pruned as the claim goes; a row
  -- exactly 60 days older is kept (2017-03-17 claims: 2017-01-15 goes, 2017-01-16 stays)
  insert into public.availability_digests (digest_day) values (date '2017-01-15'), (date '2017-01-16');
  set local role service_role;
  perform public.claim_availability_digest(date '2017-03-17');
  reset role;
  if exists (select 1 from public.availability_digests where digest_day = date '2017-01-15') then
    raise exception 'an availability email row more than 60 days old was not pruned';
  end if;
  if not exists (select 1 from public.availability_digests where digest_day = date '2017-01-16') then
    raise exception 'an availability email row exactly 60 days old was pruned';
  end if;

  -- ---- 3. only the service role may execute the claim --------------------------------
  if has_function_privilege('anon', 'public.claim_availability_digest(date)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_availability_digest(date)', 'execute') then
    raise exception 'a signed-in or anon role can execute claim_availability_digest';
  end if;
  if not has_function_privilege('service_role', 'public.claim_availability_digest(date)', 'execute') then
    raise exception 'service_role cannot execute claim_availability_digest';
  end if;

  raise notice 'migration 55 verified';
end $$;

rollback;
