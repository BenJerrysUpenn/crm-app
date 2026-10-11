import PfTopBar from "@/components/pf/PfTopBar";
import MetaBanner from "@/components/pf/MetaBanner";
import FeedMissing from "@/components/pf/FeedMissing";
import MoneyExplorer from "@/components/pf/MoneyExplorer";
import { loadPfForViewer } from "@/lib/pf/guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Money explorer" };

export default async function MoneyPage() {
  const { email, feed } = await loadPfForViewer();

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
