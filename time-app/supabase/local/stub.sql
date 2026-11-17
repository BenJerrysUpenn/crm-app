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
--   * the CRM's deals and quote_versions tables, owned by Catering-Manager,
--     with only the columns migrations 27 and 49 and their verify files use.
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

create table public.deals (id bigint primary key, event_date text, created_at text, updated_at text, round_trip_miles double precision);
-- As in production: RLS on and no policy, so no API role reads a quote.
create table public.quote_versions (
  id bigint primary key,
  deal_id integer not null references public.deals (id) on delete cascade,
  version integer not null,
  invoice_number text not null,
  docx_path text not null,
  breakdown_json text not null,
  created_at text not null,
  unique (deal_id, version)
);
alter table public.quote_versions enable row level security;

-- Supabase Storage, reduced to what migration 37's bucket and policies use:
-- the buckets and objects tables, RLS on objects as hosted Supabase has it,
-- and storage.foldername(), which splits an object's path into its folders.
create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid default auth.uid(),
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
