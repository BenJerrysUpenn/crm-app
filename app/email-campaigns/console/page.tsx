import { redirect } from "next/navigation";

// The console moved to /email-campaigns (2026-11-17). Old links land there.
export default function EmailCampaignsConsoleMoved({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, x);
  const qs = q.toString();
  redirect(`/email-campaigns${qs ? `?${qs}` : ""}`);
}
