// The pipeline card's channel badge (bj-finance #715 [task] Catering deals
// record channel + ad platform). An ad lead reads "Ad · Instagram"; every
// other channel, and every row from before Catering-Manager migration 024
// (no `source` / `ad_platform` keys at all), shows no badge.

import { describe, expect, it } from "vitest";
import { channelBadge } from "@/lib/channelBadge";

describe("channelBadge", () => {
  it("names the platform an ad lead came from", () => {
    expect(channelBadge({ source: "ad_form", ad_platform: "instagram" })?.label).toBe(
      "Ad · Instagram",
    );
    expect(channelBadge({ source: "ad_form", ad_platform: "facebook" })?.label).toBe(
      "Ad · Facebook",
    );
    expect(channelBadge({ source: "ad_form", ad_platform: "tiktok" })?.label).toBe(
      "Ad · TikTok",
    );
  });

  it("still marks an ad lead whose platform is missing", () => {
    expect(channelBadge({ source: "ad_form", ad_platform: null })?.label).toBe("Ad");
    expect(channelBadge({ source: "ad_form", ad_platform: "  " })?.label).toBe("Ad");
  });

  it("capitalises a platform added after this list", () => {
    expect(channelBadge({ source: "ad_form", ad_platform: "Pinterest" })?.label).toBe(
      "Ad · Pinterest",
    );
  });

  it("shows nothing for site-form, phone, email and manual deals", () => {
    for (const source of ["form", "phone", "email", "walk_in", "other", "migrated", null]) {
      expect(channelBadge({ source, ad_platform: "instagram" })).toBeNull();
    }
  });

  it("shows nothing on a row from before migration 024", () => {
    expect(channelBadge({})).toBeNull();
  });
});

describe("channelBadge hover title", () => {
  it("names the campaign and the ad", () => {
    expect(
      channelBadge({
        source: "ad_form",
        ad_campaign_name: " Winter catering ",
        ad_name: "Float reel",
      })?.title,
    ).toBe("Campaign: Winter catering\nAd: Float reel");
    expect(channelBadge({ source: "ad_form", ad_name: "Float reel" })?.title).toBe(
      "Ad: Float reel",
    );
  });

  it("is empty when neither is recorded, or the deal is not an ad lead", () => {
    expect(channelBadge({ source: "ad_form" })?.title).toBeNull();
    expect(
      channelBadge({ source: "ad_form", ad_campaign_name: "  ", ad_name: "" })?.title,
    ).toBeNull();
    expect(
      channelBadge({ source: "form", ad_campaign_name: "x", ad_name: "y" }),
    ).toBeNull();
  });
});
