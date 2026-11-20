import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { dayKey } from "@/lib/format";
import { loadMine } from "@/lib/reimbursements/load";
import TopBar from "@/components/TopBar";
import StaffReimbursements from "@/components/reimbursements/StaffReimbursements";

export const dynamic = "force-dynamic";

// time.withers-ventures.com/reimbursements (bj-finance #210, ruling 31): every
// staff member's own Travel Reimbursements and Lyft ride reports, and the New
// button. Owners and managers use it for their own too; deciding them is the
// Reimbursements tab of Withers Finance (/payroll/reimbursements).
export default async function ReimbursementsPage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  const mine = await loadMine(createClient(), profile.id);
  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-3xl px-4 py-6">
          {mine.ok ? (
            <StaffReimbursements reimbursements={mine.reimbursements} lyft={mine.lyft} rates={mine.rates} today={dayKey(new Date().toISOString())} />
          ) : (
            <div className="text-sm text-slate-600 dark:text-slate-400">Reimbursements are not available yet: {mine.error}</div>
          )}
        </div>
      </main>
    </div>
  );
}
