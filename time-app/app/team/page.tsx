import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import TeamAdmin from "@/components/TeamAdmin";
import type { Profile, Location } from "@/lib/types";

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

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-4xl px-4 py-6">
          <TeamAdmin
            employees={(emps as Profile[]) ?? []}
            locations={(locs as Location[]) ?? []}
          />
        </div>
      </main>
    </div>
  );
}
