import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import ScheduleBoard from "@/components/ScheduleBoard";
import type { Profile, ShiftWithEmployee, Location } from "@/lib/types";

export const dynamic = "force-dynamic";

function weekStart(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay()); // Sunday start
  return x;
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

  const base = searchParams.week ? new Date(searchParams.week) : new Date();
  const start = weekStart(base);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  let q = supabase
    .from("shifts")
    .select("*, profiles(id, full_name)")
    .gte("starts_at", start.toISOString())
    .lt("starts_at", end.toISOString())
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
            weekStartISO={start.toISOString()}
            shifts={(shifts as ShiftWithEmployee[]) ?? []}
            employees={employees}
            locations={locations}
          />
        </div>
      </main>
    </div>
  );
}
