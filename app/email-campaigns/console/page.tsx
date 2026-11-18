import { redirect } from "next/navigation";

// Old /email-campaigns/console links land on the console at /email-campaigns.
export default function EmailCampaignsConsoleMoved({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, x);
  const qs = q.toString();
  redirect(`/email-campaigns${qs ? `?${qs}` : ""}`);
}
