import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import ClockCard from "@/components/ClockCard";
import ClockInReminderModal from "@/components/ClockInReminderModal";
import ClockOutReminderBanner from "@/components/ClockOutReminderBanner";
import { getPendingReminders } from "@/lib/clockinReminders";
import { clockoutReminderDue, shiftEndForEntry } from "@/lib/clockoutReminder";
import { getSettings } from "@/lib/settings";
import type { TimeEntry, Shift, Location } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  const supabase = createClient();

  // Blocking reminders the employee has not acknowledged yet. The modal
  // covers the page until they do; /api/clock enforces it server side too.
  const pendingReminders = await getPendingReminders(supabase, profile.id);

  const { data: openEntry } = await supabase
    .from("time_entries")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("status", "open")
    .maybeSingle();

  // Still on the clock long after the shift ended? Nudge them (banner only —
  // the cron sends the notification). Snooze and dismiss live on the entry.
  const settings = await getSettings(supabase);
  let clockoutReminderEndsAt: string | null = null;
  if (openEntry) {
    const shiftEndsAt = await shiftEndForEntry(supabase, openEntry as TimeEntry);
    const { due } = clockoutReminderDue({
      entry: openEntry as TimeEntry,
      shiftEndsAt,
      afterMin: settings.clockout_reminder_after_min,
    });
    if (due) clockoutReminderEndsAt = shiftEndsAt;
  }

  const { data: recent } = await supabase
    .from("time_entries")
    .select("*")
    .eq("employee_id", profile.id)
    .order("clock_in_at", { ascending: false })
    .limit(7);

  // Find today's shift using the Eastern calendar day (not the server's UTC day).
  const todayEastern = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const win = 36 * 3600000;
  const { data: shiftWindow } = await supabase
    .from("shifts")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("published", true)
    .gte("starts_at", new Date(Date.now() - win).toISOString())
    .lte("starts_at", new Date(Date.now() + win).toISOString())
    .order("starts_at", { ascending: true });
  const shifts = (shiftWindow ?? []).filter(
    (s) =>
      new Date(s.starts_at).toLocaleDateString("en-CA", {
        timeZone: "America/New_York",
      }) === todayEastern,
  );

  const { data: locs } = await supabase
    .from("locations")
    .select("*")
    .order("is_default", { ascending: false })
    .limit(1);

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-md px-4 py-6">
          <ClockInReminderModal reminders={pendingReminders} />
          {clockoutReminderEndsAt && openEntry && (
            <ClockOutReminderBanner
              entryId={(openEntry as TimeEntry).id}
              shiftEndsAt={clockoutReminderEndsAt}
              snoozeMin={settings.clockout_reminder_after_min}
            />
          )}
          <ClockCard
            openEntry={(openEntry as TimeEntry) ?? null}
            todaysShift={(shifts?.[0] as Shift) ?? null}
            recent={(recent as TimeEntry[]) ?? []}
            location={(locs?.[0] as Location) ?? null}
          />
        </div>
      </main>
    </div>
  );
}
