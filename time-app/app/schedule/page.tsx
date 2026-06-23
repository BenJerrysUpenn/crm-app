import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import ScheduleBoard from "@/components/ScheduleBoard";
import type { Profile, ShiftWithEmployee, Location } from "@/lib/types";

export const dynamic = "force-dynamic";

const TZ = "America/New_York";

function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
// Sunday (YYYY-MM-DD, Eastern) of the week containing the given date string,
// or of "today in Eastern" when none is given.
function sundayOf(dateStr?: string): string {
  const day = dateStr ?? new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const dow = new Date(day + "T12:00:00Z").getUTCDay();
  return addDays(day, -dow);
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: { week?: string };
}) {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  const supabase = createClient();
  const isManager = profile.role === "manager";

  const weekStart = sundayOf(searchParams.week);
  // Query a window padded a day on each side, then bucket precisely by Eastern
  // date on the client. Avoids UTC-vs-Eastern off-by-one-day drift.
  const qStart = addDays(weekStart, -1) + "T00:00:00Z";
  const qEnd = addDays(weekStart, 8) + "T00:00:00Z";

  let q = supabase
    .from("shifts")
    .select("*, profiles(id, full_name)")
    .gte("starts_at", qStart)
    .lt("starts_at", qEnd)
    .order("starts_at", { ascending: true });
  if (!isManager) q = q.eq("published", true).eq("employee_id", profile.id);
  const { data: shifts } = await q;

  let employees: Profile[] = [];
  let locations: Location[] = [];
  if (isManager) {
    const { data: emps } = await supabase
      .from("profiles")
      .select("*")
      .eq("active", true)
      .order("full_name", { ascending: true });
    employees = (emps as Profile[]) ?? [];
    const { data: locs } = await supabase.from("locations").select("*").order("id");
    locations = (locs as Location[]) ?? [];
  }

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <ScheduleBoard
            isManager={isManager}
            weekStart={weekStart}
            shifts={(shifts as ShiftWithEmployee[]) ?? []}
            employees={employees}
            locations={locations}
          />
        </div>
      </main>
    </div>
  );
}
