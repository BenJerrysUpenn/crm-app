import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import CallDesk from "@/components/callDesk/CallDesk";

export const dynamic = "force-dynamic";

// /call-desk — the "Recently Contacted" call queue (bj-finance #409).
// Mobile-first: Joey works this on his phone. The page itself is a thin
// auth shell; everything live lives in the CallDesk client component.
export default async function CallDeskPage() {
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
        <CallDesk callerEmail={user.email ?? ""} />
      </main>
    </div>
  );
}
