import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { dayKey } from "@/lib/format";
import { addMonths, holidaysBetween } from "@/lib/holidays";
import { isMissingTable } from "@/lib/storeHours";
import TopBar from "@/components/TopBar";
import TeamAdmin from "@/components/TeamAdmin";
import type { ReminderWithAcks } from "@/components/ClockinRemindersAdmin";
import type {
  Profile,
  Location,
  ShiftType,
  ClockinReminder,
  StoreHours,
  StoreHoursException,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "manager") redirect("/");
  const supabase = createClient();

  const { data: emps } = await supabase
    .from("profiles")
    .select("*")
    .order("full_name", { ascending: true });
  const { data: locs } = await supabase.from("locations").select("*").order("id");
  const { data: shiftTypes } = await supabase
    .from("shift_types")
    .select("*")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  // Clock-in reminders plus who has acknowledged each one. Managers can read
  // every ack under RLS.
  const { data: reminderRows } = await supabase
    .from("clockin_reminders")
    .select("*")
    .order("created_at", { ascending: false });
  const { data: ackRows } = await supabase
    .from("clockin_reminder_acks")
    .select("reminder_id, employee_id, acknowledged_at, profiles(id, full_name)");
  const reminders: ReminderWithAcks[] = ((reminderRows as ClockinReminder[]) ?? []).map((r) => ({
    ...r,
    acks: (ackRows ?? [])
      .filter((a) => a.reminder_id === r.id)
      .map((a) => ({
        employee_id: a.employee_id as string,
        full_name:
          (a.profiles as unknown as { full_name: string | null } | null)?.full_name ?? null,
        acknowledged_at: a.acknowledged_at as string,
      })),
  }));

  // Store hours and the one-off overrides on top of them. Migration 24 creates
  // these tables; until the owner applies it by hand the queries come back with
  // "relation does not exist", which we treat as "not set up yet" so the rest
  // of the Team page still renders.
  const today = dayKey(new Date().toISOString());
  let storeHoursReady = true;
  let storeHours: StoreHours[] = [];
  let storeExceptions: StoreHoursException[] = [];
  try {
    const hoursRes = await supabase.from("store_hours").select("*").order("weekday");
    const excRes = await supabase
      .from("store_hours_exceptions")
      .select("*")
      .gte("date", today)
      .order("date");
    if (isMissingTable(hoursRes.error) || isMissingTable(excRes.error)) {
      storeHoursReady = false;
    } else {
      storeHours = (hoursRes.data as StoreHours[]) ?? [];
      storeExceptions = (excRes.data as StoreHoursException[]) ?? [];
    }
  } catch {
    storeHoursReady = false;
  }
  // Computed here rather than in the client component so the list is identical
  // on both sides of hydration.
  const holidays = holidaysBetween(today, addMonths(today, 6));

  // Map each profile id to its login email (needs the service role key).
  // Falls back to empty strings if the key isn't set (e.g. local dev).
  const emailById: Record<string, string> = {};
  try {
    const admin = createAdminClient();
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    for (const u of list?.users ?? []) emailById[u.id] = u.email ?? "";
  } catch {
    // no service role key available; emails stay blank
  }

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-4xl px-4 py-6">
          <TeamAdmin
            employees={(emps as Profile[]) ?? []}
            locations={(locs as Location[]) ?? []}
            emailById={emailById}
            settings={await getSettings(supabase)}
            shiftTypes={(shiftTypes as ShiftType[]) ?? []}
            reminders={reminders}
            employeeCount={((emps as Profile[]) ?? []).filter((e) => e.active).length}
            storeHours={storeHours}
            storeExceptions={storeExceptions}
            storeHoursReady={storeHoursReady}
            holidays={holidays}
          />
        </div>
      </main>
    </div>
  );
}
