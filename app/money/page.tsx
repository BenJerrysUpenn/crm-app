import PfTopBar from "@/components/pf/PfTopBar";
import MetaBanner from "@/components/pf/MetaBanner";
import FeedMissing from "@/components/pf/FeedMissing";
import MoneyExplorer from "@/components/pf/MoneyExplorer";
import { loadMoneyForOwner } from "@/lib/pf/access";
import { correctableCategories } from "@/lib/pf/overrides";

export const dynamic = "force-dynamic";
export const metadata = { title: "Money explorer" };

export default async function MoneyPage() {
  // Owners only; anyone else gets a 404 before the feed is read (lib/pf/access.ts).
  // The door also hands back the saved corrections, read behind the same owner
  // check, which the explorer lays over the rows' categories together with any
  // saved in the visit in one precedence pass — until the 08:00 bookkeeping
  // pass folds them into the feed (bj-finance #223).
  const { email, feed, overrides } = await loadMoneyForOwner();

  return (
    <div className="min-h-screen flex flex-col">
      <PfTopBar email={email} />
      <main className="flex-1">
        {feed.ok ? (
          <>
            <div className="pfviz" style={{ paddingBottom: 0 }}>
              <MetaBanner meta={feed.data.meta} />
            </div>
            <MoneyExplorer
              data={feed.data.explorer}
              overrides={overrides}
              categories={correctableCategories(feed.data.meta)}
            />
          </>
        ) : (
          <FeedMissing title="Money explorer" reason={feed.reason} />
        )}
      </main>
    </div>
  );
}
