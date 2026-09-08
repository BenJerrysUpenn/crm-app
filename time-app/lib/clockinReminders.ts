import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClockinReminder } from "@/lib/types";

// Active reminders this employee has not acknowledged yet, oldest first.
// Two plain queries and a filter in code: no RPC to keep in sync with the
// migration, and the row counts here are tiny.
export async function getPendingReminders(
  supabase: SupabaseClient,
  userId: string,
): Promise<ClockinReminder[]> {
  const { data: reminders } = await supabase
    .from("clockin_reminders")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (!reminders || reminders.length === 0) return [];

  const { data: acks } = await supabase
    .from("clockin_reminder_acks")
    .select("reminder_id")
    .eq("employee_id", userId);
  const acked = new Set((acks ?? []).map((a) => a.reminder_id as number));

  return (reminders as ClockinReminder[]).filter((r) => !acked.has(r.id));
}
