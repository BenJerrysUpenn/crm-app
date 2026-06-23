import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import Timesheets from "@/components/Timesheets";
import type { Profile, TimeEntryWithEmployee } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; emp?: string };
}) {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  const supabase = createClient();
  const isManager = profile.role === "manager";

  const today = new Date();
  const defFrom = new Date(today);
  defFrom.setDate(defFrom.getDate() - 13);
  const from = searchParams.from ?? defFrom.toISOString().slice(0, 10);
  const to = searchParams.to ?? today.toISOString().slice(0, 10);

  const fromTs = new Date(from + "T00:00:00").toISOString();
  const toTs = new Date(to + "T23:59:59").toISOString();

  let q = supabase
    .from("time_entries")
    .select("*, profiles(id, full_name, hourly_rate)")
    .gte("clock_in_at", fromTs)
    .lte("clock_in_at", toTs)
    .order("clock_in_at", { ascending: false });
  if (!isManager) q = q.eq("employee_id", profile.id);
  else if (searchParams.emp) q = q.eq("employee_id", searchParams.emp);
  const { data: entries } = await q;

  let employees: Profile[] = [];
  if (isManager) {
    const { data: emps } = await supabase
      .from("profiles")
      .select("*")
      .order("full_name", { ascending: true });
    employees = (emps as Profile[]) ?? [];
  }

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <Timesheets
            isManager={isManager}
            from={from}
            to={to}
            emp={searchParams.emp ?? ""}
            employees={employees}
            entries={(entries as TimeEntryWithEmployee[]) ?? []}
          />
        </div>
      </main>
    </div>
  );
}
