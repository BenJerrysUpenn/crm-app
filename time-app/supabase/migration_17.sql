-- Migration 17: link a shift back to its catering deal.
--
-- When a catering deal (in the shared `deals` table) moves into
-- "Booked Unpaid", the CRM auto-creates one open draft shift per crew member.
-- We stamp each of those shifts with the originating deal id so the creation
-- is idempotent (we never double-create for the same deal) and so a manager
-- can trace a draft back to its event.
--
-- No FK: `deals` is owned by the catering automation's schema and we don't want
-- a cross-domain constraint. deal_id is just a marker.

alter table public.shifts
  add column if not exists deal_id bigint;

create index if not exists shifts_deal_idx on public.shifts (deal_id);
