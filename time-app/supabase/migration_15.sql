-- ============================================================================
-- Withers Time — migration 15
-- Run once in the Supabase SQL editor, after migration_14.sql.
-- Default start/end times per shift type, used as scheduling "suggestions".
-- ============================================================================
alter table public.shift_types add column if not exists default_start time;
alter table public.shift_types add column if not exists default_end time;

-- Sensible defaults for the seeded types (only fills blanks).
update public.shift_types set default_start='08:00', default_end='16:00' where name='PENN Opener' and default_start is null;
update public.shift_types set default_start='16:00', default_end='22:15' where name='PENN Closer' and default_start is null;
update public.shift_types set default_start='13:00', default_end='21:00' where name='PENN Swing Shift' and default_start is null;
update public.shift_types set default_start='16:00', default_end='22:15' where name='PENN Weekend Closer' and default_start is null;
update public.shift_types set default_start='10:00', default_end='11:00' where name='Staff Meeting' and default_start is null;
update public.shift_types set default_start='11:00', default_end='15:00' where name='Catering' and default_start is null;
