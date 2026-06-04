import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import KanbanBoard from "@/components/KanbanBoard";
import type { Deal } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: deals, error } = await supabase
    .from("deals")
    .select("*")
    .eq("archived", 0)
    .order("event_date", { ascending: true });

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={user.email ?? ""} />
      <main className="flex-1 overflow-hidden">
        {error ? (
          <div className="p-8 text-red-600">
            Could not load deals: {error.message}
          </div>
        ) : (
          <KanbanBoard
            initialDeals={(deals ?? []) as Deal[]}
            userEmail={user.email ?? undefined}
          />
        )}
      </main>
    </div>
  );
}
