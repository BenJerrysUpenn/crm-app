import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import StaffingAdmin from "@/components/StaffingAdmin";
import { listLifecycles } from "@/lib/staffing/execute";
import type { Profile, ShiftType } from "@/lib/types";

export const dynamic = "force-dynamic";

// /staffing: the three manager forms (onboard, payroll setup, offboard) and
// every record with its checklist. Manager-only; employees are sent home.
export default async function StaffingPage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "manager") redirect("/");
  const supabase = createClient();

  const { data: emps } = await supabase
    .from("profiles")
    .select("*")
    .order("full_name", { ascending: true });
  const { data: shiftTypes } = await supabase
    .from("shift_types")
    .select("*")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  const records = await listLifecycles(supabase, { limit: 60 });

  // Login emails need the service role. Blank when the key is missing.
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
          <StaffingAdmin
            me={profile}
            employees={(emps as Profile[]) ?? []}
            emailById={emailById}
            shiftTypes={(shiftTypes as ShiftType[]) ?? []}
            records={records}
          />
        </div>
      </main>
    </div>
  );
}
