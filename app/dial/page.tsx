import PfTopBar from "@/components/pf/PfTopBar";
import MetaBanner from "@/components/pf/MetaBanner";
import FeedMissing from "@/components/pf/FeedMissing";
import DecisionDial from "@/components/pf/DecisionDial";
import { loadPfForOwner } from "@/lib/pf/access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Decision dial" };

export default async function DialPage() {
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
            <DecisionDial data={feed.data.dial} />
          </>
        ) : (
          <FeedMissing title="Decision dial" reason={feed.reason} />
        )}
      </main>
    </div>
  );
}
