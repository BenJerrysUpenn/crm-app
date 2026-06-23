import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import AvailabilityEditor from "@/components/AvailabilityEditor";
import ManagerAvailability from "@/components/ManagerAvailability";
import type { Availability, Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AvailabilityPage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  const supabase = createClient();
  const isManager = profile.role === "manager";

  if (isManager) {
    const { data: rows } = await supabase
      .from("availability")
      .select("*, profiles(id, full_name)")
      .order("weekday", { ascending: true });
    const { data: emps } = await supabase
      .from("profiles")
      .select("*")
      .eq("active", true)
      .order("full_name");
    return (
      <div className="min-h-screen flex flex-col">
        <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
        <main className="flex-1">
          <div className="mx-auto max-w-5xl px-4 py-6">
            <ManagerAvailability
              rows={(rows as (Availability & { profiles: Pick<Profile, "id" | "full_name"> })[]) ?? []}
              employees={(emps as Profile[]) ?? []}
            />
          </div>
        </main>
      </div>
    );
  }

  const { data: mine } = await supabase
    .from("availability")
    .select("*")
    .eq("employee_id", profile.id)
    .order("weekday", { ascending: true });

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-2xl px-4 py-6">
          <AvailabilityEditor initial={(mine as Availability[]) ?? []} />
        </div>
      </main>
    </div>
  );
}
