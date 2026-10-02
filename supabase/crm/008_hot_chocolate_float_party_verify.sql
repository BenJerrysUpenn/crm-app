-- ============================================================================
-- Withers CRM — verification for migration crm/008 (Hot Chocolate Float Party)
--
-- Run by hand against a database with 008_hot_chocolate_float_party.sql
-- applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/008_hot_chocolate_float_party_verify.sql
-- Everything happens inside one transaction that ends in ROLLBACK, and each
-- write probe also undoes itself, so no row changes. Needs at least one row
-- in public.deals. A clean run ends with "migration crm/008 verified".
--
-- WHAT IS CHECKED
--   1. deals_package_name_check accepts 'Hot Chocolate Float Party' and each
--      of the nine packages it allowed before (nothing was narrowed), still
--      accepts NULL, and still refuses a name that is not a package.
--   2. pricing_packages has the row, at $8.00 per guest, with the inclusions
--      Alina named: chocolate sauce and whipped cream; no cookies, brownies,
--      waffle cones or dry toppings.
--   3. The cookie and brownie extras the package upgrades with are still in
--      pricing_extras.
-- ============================================================================

begin;

do $$
declare
  probe_id bigint;
  pkg      text;
  outcome  text;
  r        record;
  allowed  text[] := array[
    'Cup or Cone Party',
    'Single Scoop Cup and Cone Party',
    'Waffle Cone Party',
    'Sundae Party',
    'Super Sundae Party',
    'Deluxe Sundae Party',
    'Super Deluxe Sundae Party',
    'DIY Ice Cream Social',
    'DIY Sundae Upgrade',
    'Hot Chocolate Float Party'
  ];
begin
  -- 1. the CHECK constraint, probed by writing to a real row. Each probe runs
  --    in its own sub-block and ends by raising, which rolls the UPDATE back
  --    at once; the outcome is read from which error came out.
  select id into probe_id from public.deals order by id limit 1;
  if probe_id is null then
    raise exception 'need at least one row in public.deals to run this file';
  end if;

  foreach pkg in array allowed || array[null::text] loop
    begin
      update public.deals set package_name = pkg where id = probe_id;
      raise exception using errcode = 'P0001', message = 'crm008_probe_ok';
    exception
      when check_violation then outcome := 'refused';
      when raise_exception then
        if sqlerrm <> 'crm008_probe_ok' then raise; end if;
        outcome := 'accepted';
    end;
    if outcome <> 'accepted' then
      raise exception 'deals_package_name_check refuses %', coalesce(quote_literal(pkg), 'NULL');
    end if;
  end loop;

  begin
    update public.deals set package_name = 'Hot Chocolate Party' where id = probe_id;
    raise exception using errcode = 'P0001', message = 'crm008_probe_ok';
  exception
    when check_violation then outcome := 'refused';
    when raise_exception then
      if sqlerrm <> 'crm008_probe_ok' then raise; end if;
      outcome := 'accepted';
  end;
  if outcome <> 'refused' then
    raise exception 'deals_package_name_check accepts a name that is not a package (''Hot Chocolate Party'')';
  end if;

  -- 2. the Price Book row
  select * into r from public.pricing_packages where name = 'Hot Chocolate Float Party';
  if not found then raise exception 'pricing_packages has no Hot Chocolate Float Party row'; end if;
  if r.price <> 8.00 then raise exception 'Hot Chocolate Float Party price is %, expected 8.00', r.price; end if;
  if not r.includes_sauce then raise exception 'Hot Chocolate Float Party must include (chocolate) sauce'; end if;
  if not r.includes_whipped_cream then raise exception 'Hot Chocolate Float Party must include whipped cream'; end if;
  if r.includes_cookies or r.includes_brownies then
    raise exception 'Hot Chocolate Float Party must not include cookies or brownies: they are its upgrades';
  end if;
  if r.includes_waffle_cones then raise exception 'Hot Chocolate Float Party must not include waffle cones'; end if;
  if r.dry_toppings_count <> 0 then
    raise exception 'Hot Chocolate Float Party has % dry toppings, expected 0', r.dry_toppings_count;
  end if;

  -- 3. the upgrades it is sold with
  if not exists (select 1 from public.pricing_extras where name = 'Cookies') then
    raise exception 'pricing_extras has no Cookies row (the package''s cookie upgrade)';
  end if;
  if not exists (select 1 from public.pricing_extras where name = 'Brownies') then
    raise exception 'pricing_extras has no Brownies row (the package''s brownie upgrade)';
  end if;

  raise notice 'migration crm/008 verified';
end $$;

rollback;
