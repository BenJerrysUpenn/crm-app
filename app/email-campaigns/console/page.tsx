import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import ConsoleScreen from "@/components/emailCampaignsPrototype/console/ConsoleScreen";
import { loadRawData } from "@/lib/emailCampaignsPrototype/load";
import { sequenceRepoForRequest } from "@/lib/emailCampaignsPrototype/sequenceRepo";
import { emptyState, type SharedState } from "@/lib/emailCampaignsPrototype/sharedSequences";
import { loadConsoleExtras } from "@/lib/emailCampaignsPrototype/console/load";
import { buildFacts } from "@/lib/emailCampaignsPrototype/console/facts";
import { attentionItems, idleItems } from "@/lib/emailCampaignsPrototype/console/attention";
import { applyScenario, parseScenario } from "@/lib/emailCampaignsPrototype/console/scenarios";
import { syntheticData } from "@/lib/emailCampaignsPrototype/console/synthetic";

export const dynamic = "force-dynamic";

// THROWAWAY PROTOTYPE (bj-finance #811, branch prototype/811-one-screen-console):
// the one-screen Email campaigns console, Layout A of the round 2 spec. Not for
// merge. Read-only: reads as the signed-in manager (RLS), like
// /email-campaigns, which stays untouched. No writes of any kind; every action
// button is marked prototype and does nothing.
//
// Local dev only: CONSOLE_PROTO_SYNTHETIC=1 renders a synthetic fixture with
// no login (middleware lets this one path through in development only).
export default async function EmailCampaignsConsolePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const now = new Date();
  const scenario = parseScenario(searchParams.scenario);
  const synthetic = process.env.NODE_ENV === "development" && process.env.CONSOLE_PROTO_SYNTHETIC === "1";

  let email = "synthetic fixture (no login)";
  let source: "real" | "synthetic" = "synthetic";
  let error: string | null = null;
  let facts;

  if (synthetic) {
    const { raw, extras } = syntheticData(now);
    facts = buildFacts(raw, extras, emptyState(), now);
  } else {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
    email = user.email ?? "";
    source = "real";
    let shared: SharedState = emptyState();
    try {
      const ctx = await sequenceRepoForRequest();
      if (ctx) shared = await ctx.repo.load();
    } catch {
      /* the seeds stand in, as on the tab */
    }
    try {
      const [raw, extras] = await Promise.all([loadRawData(supabase), loadConsoleExtras(supabase, now)]);
      facts = buildFacts(raw, extras, shared, now);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
      facts = buildFacts(
        { prospects: [], deals: [], sent: [], suppressedEmails: [], blockedDomains: [], mailboxes: [] },
        { mailboxes: [], sends: [], outcomes: [] },
        emptyState(),
        now,
      );
    }
  }

  const f = applyScenario(facts, scenario);
  const items = attentionItems(f);
  const idle = idleItems(f);

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={email} />
      <main className="flex-1 bg-slate-950">
        {error ? (
          <div className="m-4 rounded-md border border-dashed border-slate-500 bg-slate-900 p-3 text-sm text-slate-300">
            ◌ No data. Could not load outreach data: {error}
          </div>
        ) : (
          <ConsoleScreen facts={f} items={items} idle={idle} scenario={scenario} source={source} />
        )}
      </main>
    </div>
  );
}
