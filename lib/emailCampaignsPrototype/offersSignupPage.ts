// The opt-in page preview for the email-campaigns "Recipient pages" row
// (/email-campaigns/preview/offers-signup), shown in a sandboxed frame with a
// sample address and no database write.
//
// The page itself is live since bj-finance #425: app/offers/[token]/route.ts
// serves lib/outreach/offersPage.ts, and this file only supplies the sample
// address, so the preview renders exactly the markup the endpoint serves.

import {
  OFFERS_CONSENT_TEXT,
  consentStamp,
  offersConfirmHtml as liveConfirmHtml,
  offersSignedUpHtml as liveSignedUpHtml,
} from "@/lib/outreach/offersPage";

export { OFFERS_CONSENT_TEXT, consentStamp };

export const OFFERS_SAMPLE_EMAIL = "jordan.rivera@example.com";

/** Step 1: the landing page from the email link. Records nothing. */
export function offersConfirmHtml(email = OFFERS_SAMPLE_EMAIL): string {
  return liveConfirmHtml(email);
}

/** Step 2: after the button. */
export function offersSignedUpHtml(at: Date, email = OFFERS_SAMPLE_EMAIL): string {
  return liveSignedUpHtml(at, email);
}
