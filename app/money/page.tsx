import PfTopBar from "@/components/pf/PfTopBar";
import MetaBanner from "@/components/pf/MetaBanner";
import FeedMissing from "@/components/pf/FeedMissing";
import MoneyExplorer from "@/components/pf/MoneyExplorer";
import { loadPfForOwner } from "@/lib/pf/access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Money explorer" };

export default async function MoneyPage() {
  // Owners only; anyone else gets a 404 before the feed is read (lib/pf/access.ts).
  const { email, feed } = await loadPfForOwner();

  return (
    <div className="min-h-screen flex flex-col">
      <PfTopBar email={email} />
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
