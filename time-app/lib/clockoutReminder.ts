import type { SupabaseClient } from "@supabase/supabase-js";
import type { TimeEntry } from "@/lib/types";

// Clock-out reminder rules, in one place so the cron (which decides whether to
// notify) and the home page (which decides whether to show the banner) can
// never disagree about who is overdue.

export type ClockoutReminderInput = {
  entry: TimeEntry;
  shiftEndsAt: string | null;
  afterMin: number;
  now?: number;
};

// Someone is due a nudge when they are still on the clock, their shift ended
// at least `afterMin` ago, they haven't dismissed this entry's reminder, and
// any snooze they set has run out.
export function clockoutReminderDue(
  i: ClockoutReminderInput,
): { due: boolean; shiftEndsAt: string | null } {
  const { entry, shiftEndsAt, afterMin } = i;
  const now = i.now ?? Date.now();
  if (entry.status !== "open" || !shiftEndsAt) return { due: false, shiftEndsAt };

  const dueAt = new Date(shiftEndsAt).getTime() + afterMin * 60000;
  if (!Number.isFinite(dueAt) || now < dueAt) return { due: false, shiftEndsAt };

  if (entry.clockout_reminder_dismissed_at) return { due: false, shiftEndsAt };

  const snoozed = entry.clockout_reminder_snoozed_until;
  if (snoozed && now < new Date(snoozed).getTime()) return { due: false, shiftEndsAt };

  return { due: true, shiftEndsAt };
}

// When this entry's shift was due to end, or null if we can't tell.
// Prefers the shift the entry is linked to; failing that, matches the same way
// /api/clock links one at clock-in (a published shift starting within +/- 4h),
// which also covers rows written by the fob clock on the Raspberry Pi.
export async function shiftEndForEntry(
  supabase: SupabaseClient,
  entry: TimeEntry,
): Promise<string | null> {
  if (entry.shift_id) {
    const { data } = await supabase
      .from("shifts")
      .select("ends_at")
      .eq("id", entry.shift_id)
      .maybeSingle();
    return (data?.ends_at as string) ?? null;
  }

  const inMs = new Date(entry.clock_in_at).getTime();
  if (!Number.isFinite(inMs)) return null;
  const { data: shifts } = await supabase
    .from("shifts")
    .select("ends_at, starts_at")
    .eq("employee_id", entry.employee_id)
    .eq("published", true)
    .gte("starts_at", new Date(inMs - 4 * 3600000).toISOString())
    .lte("starts_at", new Date(inMs + 4 * 3600000).toISOString())
    .order("starts_at", { ascending: true })
    .limit(1);
  return (shifts?.[0]?.ends_at as string) ?? null;
}
