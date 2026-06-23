import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import ClockCard from "@/components/ClockCard";
import type { TimeEntry, Shift, Location } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  const supabase = createClient();

  const { data: openEntry } = await supabase
    .from("time_entries")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("status", "open")
    .maybeSingle();

  const { data: recent } = await supabase
    .from("time_entries")
    .select("*")
    .eq("employee_id", profile.id)
    .order("clock_in_at", { ascending: false })
    .limit(7);

  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const endToday = new Date();
  endToday.setHours(23, 59, 59, 999);
  const { data: shifts } = await supabase
    .from("shifts")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("published", true)
    .gte("starts_at", startToday.toISOString())
    .lte("starts_at", endToday.toISOString())
    .order("starts_at", { ascending: true })
    .limit(1);

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
