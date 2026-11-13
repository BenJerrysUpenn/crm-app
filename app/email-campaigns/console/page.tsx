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
import { buildSalesLanes, loadSalesLanes, salesLanesFixture, type SalesLanesData } from "@/lib/emailCampaignsPrototype/console/salesLanes";
import { readFile } from "node:fs/promises";

/**
 * Local dev only (synthetic mode): the sales lane numbers. ?sales=empty |
 * stale | unrecognised | unreadable shows each state; otherwise the
 * synthetic fixture, or the JSON payload file CONSOLE_PROTO_SALES_LANES
 * names (kept outside this public repo).
 */
async function devSalesLanes(param: string | string[] | undefined, now: Date): Promise<SalesLanesData> {
  const want = Array.isArray(param) ? param[0] : param;
  if (want === "empty") return buildSalesLanes({ status: "read", row: null }, now);
  if (want === "unreadable") return buildSalesLanes({ status: "unreadable", message: "permission denied for table metrics_snapshots (synthetic)" }, now);
  const file = process.env.CONSOLE_PROTO_SALES_LANES;
  const payload = want === "unrecognised" ? { schema: 2 } : file ? JSON.parse(await readFile(file, "utf8")) : salesLanesFixture(now);
  const builtAt = want === "stale" ? new Date(now.getTime() - 2 * 86_400_000).toISOString() : now.toISOString();
  const data = buildSalesLanes({ status: "read", row: { period: "", built_at: builtAt, payload } }, now);
  return data.status === "ok" ? { ...data, synthetic: file ? `local file ${file.split("/").pop()}` : "synthetic sales_lanes fixture" } : data;
}

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
    facts = buildFacts(raw, extras, emptyState(), now, await devSalesLanes(searchParams.sales, now));
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
      const [raw, extras, sales] = await Promise.all([loadRawData(supabase), loadConsoleExtras(supabase, now), loadSalesLanes(supabase)]);
      facts = buildFacts(raw, extras, shared, now, buildSalesLanes(sales, now));
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
      facts = buildFacts(
        { prospects: [], deals: [], sent: [], suppressedEmails: [], blockedDomains: [], mailboxes: [] },
        { mailboxes: [], sends: [], outcomes: [] },
        emptyState(),
        now,
        { status: "unreadable", message: error },
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
