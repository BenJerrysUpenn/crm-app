import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import Funnels from "@/components/funnels/Funnels";

export const dynamic = "force-dynamic";

// /funnels — the on-the-loop supervision view of the automated email sales
// funnels (bj-finance #422). The machine runs the loop (warm/cold engines,
// sweep, quotes, boomerangs); this tab is where a human watches it flow and
// intervenes on exceptions only. Thin auth shell; everything live is in the
// Funnels client component, which fetches /api/funnels with cache: 'no-store'.
export default async function FunnelsPage() {
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
        <Funnels />
      </main>
    </div>
  );
}
