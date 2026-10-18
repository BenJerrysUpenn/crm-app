import PfTopBar from "@/components/pf/PfTopBar";
import MetaBanner from "@/components/pf/MetaBanner";
import FeedMissing from "@/components/pf/FeedMissing";
import MoneyExplorer from "@/components/pf/MoneyExplorer";
import { loadPfForOwner } from "@/lib/pf/access";
import { applyOverrides, loadOverrides } from "@/lib/pf/overrides";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Money explorer" };

export default async function MoneyPage() {
  // Owners only; anyone else gets a 404 before the feed is read (lib/pf/access.ts).
  const { email, feed } = await loadPfForOwner();
  // Saved corrections are laid over the rows' categories until the 08:00
  // bookkeeping pass folds them into the feed (bj-finance #223).
  const overrides = feed.ok
    ? await loadOverrides(createAdminClient())
    : [];

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
              data={{
                ...feed.data.explorer,
                rows: applyOverrides(feed.data.explorer.rows, overrides),
              }}
              categories={feed.data.meta.categories ?? []}
            />
          </>
        ) : (
          <FeedMissing title="Money explorer" reason={feed.reason} />
        )}
      </main>
    </div>
  );
}
