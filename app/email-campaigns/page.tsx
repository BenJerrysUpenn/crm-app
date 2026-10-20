import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import EmailCampaignsPrototype from "@/components/emailCampaignsPrototype/EmailCampaignsPrototype";
import { loadRawData } from "@/lib/emailCampaignsPrototype/load";
import { compute, type RawData } from "@/lib/emailCampaignsPrototype/model";
import { sequenceRepoForRequest } from "@/lib/emailCampaignsPrototype/sequenceRepo";
import { emptyState, type SharedState } from "@/lib/emailCampaignsPrototype/sharedSequences";

export const dynamic = "force-dynamic";

// /email-campaigns: the outreach tiers (Cold, Warm, Offer), their categories,
// sequences and sending capacity. Read-only: the page reads as the signed-in
// manager (RLS `(select is_manager())`) and computes every tier/category/
// bucket in lib/emailCampaignsPrototype/model.ts. The sequence editor's shared
// copy (supabase/crm/013) is read here too and written through
// /api/email-campaigns/sequences.
export default async function EmailCampaignsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let raw: RawData;
  let error: string | null = null;
  try {
    // Local dev only: render from a JSON dump instead of Supabase.
    if (process.env.NODE_ENV === "development" && process.env.EMAIL_CAMPAIGNS_FIXTURE) {
      const { readFileSync } = await import("node:fs");
      raw = JSON.parse(readFileSync(process.env.EMAIL_CAMPAIGNS_FIXTURE, "utf8"));
    } else {
      raw = await loadRawData(supabase);
    }
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : String(e);
    raw = { prospects: [], deals: [], sent: [], suppressedEmails: [], blockedDomains: [], mailboxes: [] };
  }
  const payload = compute(raw, new Date());

  let shared: SharedState = emptyState();
  let sharedError: string | null = null;
  try {
    const ctx = await sequenceRepoForRequest();
    if (ctx) shared = await ctx.repo.load();
  } catch (e: unknown) {
    sharedError = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={user.email ?? ""} />
      <main className="flex-1 bg-slate-950">
        {error ? (
          <div className="m-4 rounded-md border border-rose-700 bg-rose-950/40 p-3 text-sm text-rose-200">
            Could not load outreach data: {error}
          </div>
        ) : null}
        <EmailCampaignsPrototype payload={payload} shared={shared} sharedError={sharedError} />
      </main>
    </div>
  );
}
