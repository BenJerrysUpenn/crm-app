-- Migration 18: make catering draft-shift creation duplication-proof.
--
-- Background: the reconciler creates one open draft shift per crew member for a
-- booked deal. Its "create once" guard (skip if the deal already has shifts) is
-- an optimization, not a guarantee — two calls racing past it could both
-- insert. This adds a hard, DB-level guard that still allows multi-crew events.
--
-- deal_slot numbers the crew members of a single deal (1..staff_count). The
-- unique index means a given (deal_id, slot) can exist only once, so a duplicate
-- insert fails / is ignored instead of piling up. Multi-crew events are fine:
-- their rows share deal_id but have distinct slots.

alter table public.shifts
  add column if not exists deal_slot smallint;

-- Backfill existing catering shifts with sequential slots per deal.
with numbered as (
  select id, row_number() over (partition by deal_id order by id) rn
  from public.shifts
  where deal_id is not null
)
update public.shifts s
  set deal_slot = n.rn
  from numbered n
  where n.id = s.id and s.deal_slot is null;

create unique index if not exists shifts_deal_slot_uidx
  on public.shifts (deal_id, deal_slot)
  where deal_id is not null;
