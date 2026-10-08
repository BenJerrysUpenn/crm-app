-- ============================================================================
-- The parts of a hosted Supabase project that the time-app migrations and
-- their *_verify.sql files lean on, for a throwaway local Postgres. Used by
-- supabase/local/verify.sh only. Never run this against a real project.
--
--   * the API roles: anon, authenticated, and service_role (which bypasses
--     RLS, as it does on Supabase);
--   * auth.users / sessions / refresh_tokens, reduced to the columns used here;
--   * auth.uid() and auth.role(), which read the JWT claims PostgREST sets
--     (the verify files set request.jwt.claims by hand to impersonate one);
--   * Supabase's default grants on the public schema;
--   * the CRM's deals table, owned by Catering-Manager, with only the columns
--     migration 27 reads.
-- ============================================================================

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  banned_until timestamptz,
  created_at timestamptz default now()
);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid);
create table auth.refresh_tokens (id bigserial primary key, user_id varchar);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')), '')::text
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create table public.deals (id bigint primary key, event_date text);
