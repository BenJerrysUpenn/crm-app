-- ============================================================================
-- Withers Time — verification for migration 29 (plain shifts_deal_slot_uidx)
--
-- Run by hand against a database with migration 29 applied. READ ONLY: the
-- whole file runs inside BEGIN READ ONLY and ends in ROLLBACK, so Postgres
-- itself refuses any write, and nothing it does can change a row. A clean run
-- ends with "migration 29 verified" and prints the shift counts to compare
-- with the counts taken before the migration.
--
-- WHAT IS CHECKED
--   1. shifts_deal_slot_uidx exists, is unique, covers (deal_id, deal_slot) in
--      that order, and has no WHERE predicate.
--   2. Neither temporary name (_plain from the migration, _partial from the
--      rollback) was left behind.
--   3. The web routes' insert, ON CONFLICT (deal_id, deal_slot) DO NOTHING
--      (supabase-js upsert with ignoreDuplicates), plans. Before migration 29
--      this is the statement Postgres refused (crm-app #35).
--   4. The local CLI's insert, ON CONFLICT (deal_id, deal_slot)
--      WHERE deal_id IS NOT NULL DO NOTHING (lib/cateringShiftsPg.ts), still
--      plans.
-- EXPLAIN without ANALYZE plans a statement without running it, and is
-- allowed in a read-only transaction.
-- ============================================================================

begin read only;

do $$
declare
  idx    record;
  n      integer;
  plan   text;
  shape  text;
  shapes text[] := array[
    'on conflict (deal_id, deal_slot) do nothing',
    'on conflict (deal_id, deal_slot) where deal_id is not null do nothing'
  ];
begin
  -- 1. the index itself
  select i.indisunique,
         i.indpred is null as plain,
         array(select a.attname::text
                 from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                order by k.ord) as cols
    into idx
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
   where c.relname = 'shifts_deal_slot_uidx'
     and c.relnamespace = 'public'::regnamespace;

  if not found then raise exception 'public.shifts_deal_slot_uidx is missing'; end if;
  if not idx.indisunique then raise exception 'shifts_deal_slot_uidx is not unique'; end if;
  if not idx.plain then raise exception 'shifts_deal_slot_uidx still has a WHERE predicate; migration 29 has not run'; end if;
  if idx.cols is distinct from array['deal_id', 'deal_slot'] then
    raise exception 'shifts_deal_slot_uidx covers %, expected {deal_id,deal_slot}', idx.cols;
  end if;

  -- 2. no temporary index left over
  select count(*) into n
    from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('shifts_deal_slot_uidx_plain', 'shifts_deal_slot_uidx_partial');
  if n <> 0 then raise exception 'a temporary shifts_deal_slot_uidx_* index was left behind'; end if;

  -- 3 and 4. both ON CONFLICT shapes plan against the real table and index
  foreach shape in array shapes loop
    begin
      execute format(
        'explain insert into public.shifts
           (employee_id, starts_at, ends_at, position, notes, published, deal_id, deal_slot)
         values (null, now(), now() + interval ''4 hours'', ''Catering'', ''verify-29'', false, -29, 1)
         %s', shape)
        into plan;
    exception when others then
      raise exception 'insert with "%" does not plan: %', shape, sqlerrm;
    end;
    raise notice 'plans: %', shape;
  end loop;

  raise notice 'shifts: % rows, % with a deal_id, % with a deal_id and no deal_slot',
    (select count(*) from public.shifts),
    (select count(deal_id) from public.shifts),
    (select count(*) from public.shifts where deal_id is not null and deal_slot is null);

  raise notice 'migration 29 verified';
end $$;

rollback;
