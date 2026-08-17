import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import PfTopBar from "@/components/pf/PfTopBar";
import MetaBanner from "@/components/pf/MetaBanner";
import FeedMissing from "@/components/pf/FeedMissing";
import MoneyExplorer from "@/components/pf/MoneyExplorer";
import { loadPfData } from "@/lib/pf/data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Money explorer" };

export default async function MoneyPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const feed = await loadPfData();

  return (
    <div className="min-h-screen flex flex-col">
      <PfTopBar email={user.email ?? ""} />
      <main className="flex-1">
        {feed.ok ? (
          <>
            <div className="pfviz" style={{ paddingBottom: 0 }}>
              <MetaBanner meta={feed.data.meta} />
            </div>
            <MoneyExplorer data={feed.data.explorer} />
          </>
        ) : (
          <FeedMissing title="Money explorer" reason={feed.reason} />
        )}
      </main>
    </div>
  );
}
