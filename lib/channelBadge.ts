// Channel badge on the pipeline deal card (bj-finance #715 [task] Catering
// deals record channel + ad platform).
//
// Catering-Manager owns the deals schema: migration 024 added
// `source = 'ad_form'` (a person who submitted an ad's instant form) and the
// `ad_platform` / `ad_campaign_name` / `ad_name` columns. This app only reads
// them. Until 024 is applied the columns are simply absent from `select("*")`
// rows, so every field here is optional and a missing one shows no badge.

import type { Deal } from "@/lib/types";

export const AD_FORM_SOURCE = "ad_form";

const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
};

type ChannelFields = Pick<
  Deal,
  "source" | "ad_platform" | "ad_campaign_name" | "ad_name"
>;

function platformLabel(platform: string | null | undefined): string | null {
  const key = (platform ?? "").trim().toLowerCase();
  if (!key) return null;
  return PLATFORM_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** What the card shows for a deal's channel: the badge text ("Ad · Instagram"
 *  for an ad lead, "Ad" when the platform is unknown) and its hover text naming
 *  the campaign and ad (null when neither is recorded). Null for every other
 *  channel (no badge). */
export type ChannelBadge = { label: string; title: string | null };

export function channelBadge(deal: ChannelFields): ChannelBadge | null {
  if (deal.source !== AD_FORM_SOURCE) return null;
  const platform = platformLabel(deal.ad_platform);
  const lines: string[] = [];
  if (deal.ad_campaign_name?.trim()) lines.push(`Campaign: ${deal.ad_campaign_name.trim()}`);
  if (deal.ad_name?.trim()) lines.push(`Ad: ${deal.ad_name.trim()}`);
  return {
    label: platform ? `Ad · ${platform}` : "Ad",
    title: lines.length ? lines.join("\n") : null,
  };
}
