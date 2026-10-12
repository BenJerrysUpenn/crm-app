import PfTopBar from "@/components/pf/PfTopBar";
import MetaBanner from "@/components/pf/MetaBanner";
import FeedMissing from "@/components/pf/FeedMissing";
import SafeToSpend from "@/components/pf/SafeToSpend";
import { loadPfForViewer } from "@/lib/pf/guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Safe to spend" };

export default async function SafePage() {
  const { email, feed } = await loadPfForViewer();

  return (
    <div className="min-h-screen flex flex-col">
      <PfTopBar email={email} />
      <main className="flex-1">
        {feed.ok ? (
          <>
            <div
              className="pfviz"
              style={{ paddingBottom: 0, textAlign: "center" }}
            >
              <MetaBanner meta={feed.data.meta} />
            </div>
            <SafeToSpend data={feed.data.safe_to_spend} />
          </>
        ) : (
          <FeedMissing title="Safe to spend" reason={feed.reason} />
        )}
      </main>
    </div>
  );
}
