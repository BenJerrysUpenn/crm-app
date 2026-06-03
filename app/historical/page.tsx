import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import HistoricalView from "@/components/HistoricalView";

export const dynamic = "force-dynamic";

export default async function HistoricalPage() {
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
      <main className="flex-1 overflow-hidden">
        <HistoricalView />
      </main>
    </div>
  );
}
