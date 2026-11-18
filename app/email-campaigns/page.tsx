import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { readFile } from "node:fs/promises";
import TopBar from "@/components/TopBar";
import ConsoleScreen from "@/components/emailCampaignsPrototype/console/ConsoleScreen";
import { loadRawData } from "@/lib/emailCampaignsPrototype/load";
import { sequenceRepoForRequest } from "@/lib/emailCampaignsPrototype/sequenceRepo";
import { emptyState, type SharedState } from "@/lib/emailCampaignsPrototype/sharedSequences";
import { loadConsoleExtras } from "@/lib/emailCampaignsPrototype/console/load";
import { buildFacts } from "@/lib/emailCampaignsPrototype/console/facts";
import { LEVEL_RANK, attentionItems, idleItems } from "@/lib/emailCampaignsPrototype/console/attention";
import { applyLoopScenario, applyScenario, parseScenario } from "@/lib/emailCampaignsPrototype/console/scenarios";
import { loopItems, withHistory, type LoopFacts } from "@/lib/emailCampaignsPrototype/console/loop";
import { buildLoopLive, emptyLoop, loadLoopLive } from "@/lib/emailCampaignsPrototype/console/loopLive";
import { syntheticLoop } from "@/lib/emailCampaignsPrototype/console/loopSynthetic";
import { syntheticData } from "@/lib/emailCampaignsPrototype/console/synthetic";
import { buildSalesLanes, loadSalesLanes, salesLanesFixture, type SalesLanesData } from "@/lib/emailCampaignsPrototype/console/salesLanes";

export const dynamic = "force-dynamic";

// /email-campaigns: the one-screen console for the weekly email loop
// (bj-finance #811 spec, #964 loop). Alina, 2026-11-17: "yes build, but you
// can go all the way with it, rather than having read only".
//
// Reads as the signed-in manager (RLS `(select is_manager())`; the loop
// tables through supabase/crm/014). Writes only through
// /api/email-campaigns/loop: approve an approach, hold or release one email,
// pause or resume the loop. The hand-run tiers' old screen is at
// /email-campaigns/classic.
//
// Local dev only: CONSOLE_PROTO_SYNTHETIC=1 renders a synthetic fixture with
// no login (middleware lets this one path through in development only), with
// the scenario bar for the attention rules. Never in production or previews.

/** Local dev only: the sales lane numbers. ?sales=empty | stale |
 * unrecognised | unreadable shows each state; otherwise the synthetic
 * fixture, or the JSON payload file CONSOLE_PROTO_SALES_LANES names (kept
 * outside this public repo). */
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

export default async function EmailCampaignsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const now = new Date();
  const synthetic = process.env.NODE_ENV === "development" && process.env.CONSOLE_PROTO_SYNTHETIC === "1";
  const scenario = synthetic ? parseScenario(searchParams.scenario) : "none";

  let email = "synthetic fixture (no login)";
  let error: string | null = null;
  let facts;
  let loop: LoopFacts;

  if (synthetic) {
    const { raw, extras } = syntheticData(now);
    facts = buildFacts(raw, extras, emptyState(), now, await devSalesLanes(searchParams.sales, now));
    // CONSOLE_PROTO_LOOP_ROWS: a local dump of real loop rows (kept outside
    // this public repo) run through the live builder, to check it by eye.
    const dump = process.env.CONSOLE_PROTO_LOOP_ROWS;
    if (dump) {
      const j = JSON.parse(await readFile(dump, "utf8"));
      loop = buildLoopLive(j.rows, { ...j.ctx, people: new Map(j.ctx.people) }, now);
      loop.synthetic = `real loop rows from a local dump (${dump.split("/").pop()})`;
    } else loop = syntheticLoop(now);
  } else {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
    email = user.email ?? "";
    let shared: SharedState = emptyState();
    try {
      const ctx = await sequenceRepoForRequest();
      if (ctx) shared = await ctx.repo.load();
    } catch {
      /* the seeds stand in, as on the classic screen */
    }
    try {
      const [raw, extras, sales, loopIn] = await Promise.all([loadRawData(supabase), loadConsoleExtras(supabase, now), loadSalesLanes(supabase), loadLoopLive(supabase, now)]);
      facts = buildFacts(raw, extras, shared, now, buildSalesLanes(sales, now));
      if (loopIn.status === "read") {
        const people = new Map(raw.prospects.map((x) => [x.id, { name: x.name, company: x.company, email: x.email }]));
        loop = buildLoopLive(loopIn.rows, { people, outcomes: extras.outcomes, sends: extras.sends, deals: raw.deals, mailboxes: extras.mailboxes }, now);
      } else
        loop = emptyLoop(
          now,
          loopIn.status === "empty" ? "The loop has not logged a weekly run yet." : `The loop's tables are not readable yet (${loopIn.message}).`,
        );
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
      facts = buildFacts(
        { prospects: [], deals: [], sent: [], suppressedEmails: [], blockedDomains: [], mailboxes: [] },
        { mailboxes: [], sends: [], outcomes: [] },
        emptyState(),
        now,
        { status: "unreadable", message: error },
      );
      loop = emptyLoop(now, error);
    }
  }

  const f = applyScenario(facts, scenario);
  // What people sent by hand is the loop's starting data, read from the
  // sales numbers snapshot at runtime (never written into this public repo).
  const sales = f.sales.status === "ok" ? f.sales : null;
  loop = withHistory(loop, sales ? sales.snapshot.lanes : null, sales?.synthetic);
  const L = applyLoopScenario(loop, scenario);
  // The hand-run lanes are off this screen (the classic screen has them), so their rules are too.
  const items = [...loopItems(L), ...attentionItems(f).filter((i) => i.path[0] !== "lanes")].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  const idle = idleItems(f);

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={email} />
      <main className="flex-1 bg-slate-950">
        {error ? (
          <div className="m-4 rounded-md border border-dashed border-slate-500 bg-slate-900 p-3 text-sm text-slate-300">◌ No data. Could not load outreach data: {error}</div>
        ) : (
          <>
            {L.unavailable ? (
              <div className="mx-4 mt-3 rounded-md border border-dashed border-slate-500 bg-slate-900 p-2 text-xs text-slate-300">◌ {L.unavailable}</div>
            ) : null}
            <ConsoleScreen facts={f} loop={L} items={items} idle={idle} scenario={scenario} source={synthetic ? "synthetic" : "real"} />
          </>
        )}
        <p className="px-4 pb-20 pt-2 text-right text-[11px] text-slate-500 sm:pb-3">
          <Link href="/email-campaigns/classic" className="hover:text-slate-300 hover:underline">
            Hand-run tiers, sequences and contacts: the classic screen →
          </Link>
        </p>
      </main>
    </div>
  );
}
