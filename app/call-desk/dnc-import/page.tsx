import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import DncImportForm from "@/components/callDesk/DncImportForm";

export const dynamic = "force-dynamic";

// /call-desk/dnc-import — load a do-not-call registry scrub (bj-finance #420).
//
// Deliberately plain and deliberately unlinked from the call desk's main
// chrome: this is run a handful of times a year by whoever holds the registry
// subscriptions, not by the person working the queue. Manager-only, like every
// page here (middleware.ts).
export default async function DncImportPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={user.email ?? ""} />
      <main className="flex-1 bg-slate-950">
        <DncImportForm />
      </main>
    </div>
  );
}
