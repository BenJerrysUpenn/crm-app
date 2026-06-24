-- ============================================================================
-- Withers Time — migration 8
-- Run once in the Supabase SQL editor, after migration_7.sql.
-- Lets a user clear (delete) their own notifications.
-- (migration_7 was the notif_select fix: using (user_id = auth.uid()).)
-- ============================================================================
drop policy if exists notif_delete on public.notifications;
create policy notif_delete on public.notifications for delete to authenticated
  using (user_id = auth.uid());
