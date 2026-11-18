// /email-campaigns/console moved to /email-campaigns (2026-11-17). An old
// link, query string and all, lands on the console at its new address.

import { describe, expect, it } from "vitest";
import { getURLFromRedirectError, isRedirectError } from "next/dist/client/components/redirect";
import EmailCampaignsConsoleMoved from "@/app/email-campaigns/console/page";

/** Where the page sends the browser: Next's redirect() throws, carrying the target. */
function landsOn(searchParams: Record<string, string | string[] | undefined>): string {
  try {
    EmailCampaignsConsoleMoved({ searchParams });
  } catch (e) {
    if (isRedirectError(e)) return getURLFromRedirectError(e);
    throw e;
  }
  throw new Error("the page did not redirect");
}

describe("an old /email-campaigns/console link", () => {
  it("lands on /email-campaigns", () => {
    expect(landsOn({})).toBe("/email-campaigns");
  });

  it("keeps its query, every value of a repeated key, and leaves out an absent one", () => {
    expect(landsOn({ panel: "emails", type: ["warm:corporate", "cold:office_manager"], q: undefined })).toBe(
      "/email-campaigns?panel=emails&type=warm%3Acorporate&type=cold%3Aoffice_manager",
    );
  });
});
