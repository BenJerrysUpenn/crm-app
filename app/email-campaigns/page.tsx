import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import EmailCampaignsPrototype from "@/components/emailCampaignsPrototype/EmailCampaignsPrototype";
import { loadRawData } from "@/lib/emailCampaignsPrototype/load";
import { compute, type RawData } from "@/lib/emailCampaignsPrototype/model";

export const dynamic = "force-dynamic";

// /email-campaigns — PROTOTYPE (branch prototype/email-campaigns, never main).
// One layout (v2; the v1 ?variant=B ledger was dropped). Read-only: the page
// reads as the signed-in manager (RLS `(select is_manager())`) and computes
// every tier/category/bucket in lib/emailCampaignsPrototype/model.ts.
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

  // v5: "Sourced by" on the + Add contacts form (prototype, nothing saved).
  const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
  const sourcedBy = (profile as { full_name: string | null } | null)?.full_name || user.email || "you";

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={user.email ?? ""} />
      <main className="flex-1 bg-slate-950">
        {error ? (
          <div className="m-4 rounded-md border border-rose-700 bg-rose-950/40 p-3 text-sm text-rose-200">
            Could not load outreach data: {error}
          </div>
        ) : null}
        <EmailCampaignsPrototype payload={payload} sourcedBy={sourcedBy} />
      </main>
    </div>
  );
}
