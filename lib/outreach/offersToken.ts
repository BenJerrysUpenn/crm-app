import { createHmac } from "node:crypto";
import {
  emailKey,
  macMatches,
  parseUnsubscribeToken,
  type ParsedToken,
} from "@/lib/outreach/unsubscribeToken";

// "Yes, send me offers" opt-in tokens (bj-finance #425, owners' ruling
// 2026-09-27). Catering-Manager's outreach/warm_sender.py mints them into the
// warm footer; app/offers/[token]/route.ts verifies them. This file is the
// truth for the contract; the sender's `offers_token` is its transliteration,
// and both test suites pin the same literal vector.
//
//   payload   = `${prospect_id}.${hex(HMAC_SHA256(secret, mac_input))}`
//   mac_input = `offers:${prospect_id}:${email_key}`
//   email_key = email, whitespace-trimmed, lowercased
//   token     = base64url(payload), unpadded
//
// PURPOSE SEPARATION. The key is UNSUBSCRIBE_SECRET, reused on purpose: it is
// already in Vault, on Vercel and on the droplet, and a second signing key is
// a second thing to keep byte-identical in three places. What keeps the two
// token kinds apart is the MAC input. An unsubscribe MAC is taken over
// `<id>:<email>`, which always starts with a digit; an offers MAC over
// `offers:<id>:<email>`, which never does. No message is in both spaces, so
// no MAC verifies for both purposes: an unsubscribe token presented here is a
// 404, and an offers token presented to /api/unsubscribe is a 404. The token
// SHAPE is deliberately the same, so the parser is shared rather than copied.

export const OFFERS_MAC_PREFIX = "offers:";

/** hex(HMAC_SHA256(secret, `offers:${prospectId}:${emailKey(email)}`)). */
export function offersMac(
  prospectId: number | string,
  email: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${OFFERS_MAC_PREFIX}${prospectId}:${emailKey(email)}`)
    .digest("hex");
}

/** The token that goes in the footer's "Yes, send me offers" URL. */
export function mintOffersToken(
  prospectId: number | string,
  email: string,
  secret: string,
): string {
  const payload = `${prospectId}.${offersMac(prospectId, email, secret)}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

/** Structure only; same shape as an unsubscribe token. Null when malformed. */
export function parseOffersToken(token: string): ParsedToken | null {
  return parseUnsubscribeToken(token);
}

/** Verify a parsed token against the address stored for that prospect. */
export function verifyOffersToken(
  parsed: ParsedToken,
  storedEmail: string,
  secret: string,
): boolean {
  return macMatches(parsed.mac, offersMac(parsed.prospectId, storedEmail, secret));
}
