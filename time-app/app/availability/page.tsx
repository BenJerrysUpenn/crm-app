import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import AvailabilityGrid from "@/components/AvailabilityGrid";
import ManagerAvailability from "@/components/ManagerAvailability";
import type { Availability, Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function sundayOf(dateStr?: string): string {
  const base = dateStr ? new Date(dateStr + "T00:00:00Z") : new Date();
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: { week?: string };
}) {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  const supabase = createClient();
  const isManager = profile.role === "manager";

  const weekStart = sundayOf(searchParams.week);
  const weekEnd = addDays(weekStart, 7);

  if (isManager) {
    // Team availability for the selected week.
    const { data: weekRows } = await supabase
      .from("availability")
      .select("*, profiles(id, full_name)")
      .eq("is_available", true)
      .not("specific_date", "is", null)
      .gte("specific_date", weekStart)
      .lt("specific_date", weekEnd)
      .order("specific_date", { ascending: true });
    // All pending time-off requests (any date), plus recently decided ones.
    const { data: timeOff } = await supabase
      .from("availability")
      .select("*, profiles(id, full_name)")
      .eq("is_available", false)
      .order("specific_date", { ascending: true });

    return (
      <div className="min-h-screen flex flex-col">
        <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
        <main className="flex-1">
          <div className="mx-auto max-w-5xl px-4 py-6">
            <ManagerAvailability
              weekStart={weekStart}
              weekRows={(weekRows as (Availability & { profiles: Pick<Profile, "id" | "full_name"> })[]) ?? []}
              timeOff={(timeOff as (Availability & { profiles: Pick<Profile, "id" | "full_name"> })[]) ?? []}
            />
          </div>
        </main>
      </div>
    );
  }

  // Employee: this week's painted availability + their time-off requests.
  const { data: weekRows } = await supabase
    .from("availability")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("is_available", true)
    .not("specific_date", "is", null)
    .gte("specific_date", weekStart)
    .lt("specific_date", weekEnd);
  const { data: timeOff } = await supabase
    .from("availability")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("is_available", false)
    .order("specific_date", { ascending: true });

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-3xl px-4 py-6">
          <AvailabilityGrid
            weekStart={weekStart}
            weekRows={(weekRows as Availability[]) ?? []}
            timeOff={(timeOff as Availability[]) ?? []}
          />
        </div>
      </main>
    </div>
  );
}
