import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import AvailabilityCalendar from "@/components/AvailabilityCalendar";
import ManagerAvailability from "@/components/ManagerAvailability";
import type { Availability, Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

const TZ = "America/New_York";
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
  searchParams: { week?: string; month?: string };
}) {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  const supabase = createClient();
  const isManager = profile.role === "manager";

  // ---- Manager: weekly team availability (unchanged) ----
  if (isManager) {
    const weekStart = sundayOf(searchParams.week);
    const weekEnd = addDays(weekStart, 7);
    const { data: weekRows } = await supabase
      .from("availability")
      .select("*, profiles(id, full_name)")
      .eq("is_available", true)
      .not("specific_date", "is", null)
      .gte("specific_date", weekStart)
      .lt("specific_date", weekEnd)
      .order("specific_date", { ascending: true });
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

  // ---- Employee: month calendar of availability preferences ----
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const monthKey = searchParams.month ?? today.slice(0, 7); // YYYY-MM
  const monthStart = monthKey + "-01";
  const gridStart = sundayOf(monthStart);
  const gridEnd = addDays(gridStart, 42);

  const { data: specific } = await supabase
    .from("availability")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("is_available", true)
    .not("specific_date", "is", null)
    .gte("specific_date", gridStart)
    .lt("specific_date", gridEnd);

  const { data: recurring } = await supabase
    .from("availability")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("is_available", true)
    .not("weekday", "is", null);

  const { data: timeOff } = await supabase
    .from("availability")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("is_available", false)
    .order("specific_date", { ascending: true });

  const { data: pub } = await supabase
    .from("shifts")
    .select("starts_at")
    .eq("published", true)
    .gte("starts_at", gridStart + "T00:00:00Z")
    .lt("starts_at", gridEnd + "T00:00:00Z");
  const lockedDays = Array.from(
    new Set((pub ?? []).map((s) => new Date(s.starts_at as string).toLocaleDateString("en-CA", { timeZone: TZ }))),
  );

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <AvailabilityCalendar
            monthKey={monthKey}
            gridStart={gridStart}
            specific={(specific as Availability[]) ?? []}
            recurring={(recurring as Availability[]) ?? []}
            timeOff={(timeOff as Availability[]) ?? []}
            lockedDays={lockedDays}
            today={today}
          />
        </div>
      </main>
    </div>
  );
}
