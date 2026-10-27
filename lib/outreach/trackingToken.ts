import { createHmac } from "node:crypto";
import { emailKey, macMatches } from "@/lib/outreach/unsubscribeToken";

// Open and click tracking tokens for the warm and wedding outreach lanes
// (owners' ruling 2026-10-27: "add it"). Catering-Manager's
// outreach/warm_sender.py mints them; app/api/t/o/[token] and
// app/api/t/c/[token] verify them. This file is the truth for the contract;
// docs/tracking.md is the prose version, and both test suites pin the same
// literal vectors (tests/trackingToken.test.ts here).
//
//   tid       = 16 lowercase hex chars, one per sent message (the sender
//               stores it in the 'sequenced' event's detail.tracking_id)
//   email_key = email, whitespace-trimmed, lowercased
//   open mac  = hex(HMAC_SHA256(secret, `open:${id}:${tid}:${email_key}`))
//   click mac = hex(HMAC_SHA256(secret, `click:${id}:${tid}:${email_key}:${url}`))
//   token     = base64url(`${id}.${tid}.${mac}`), unpadded
//
// PURPOSE SEPARATION. The key is UNSUBSCRIBE_SECRET, as for offers tokens and
// for the same reason (one signing key to keep identical in three places).
// The MAC inputs keep the purposes apart: `open:` and `click:` prefixes never
// collide with each other, with `offers:`, or with an unsubscribe input
// (which starts with a digit). The token SHAPE differs too: three dot-separated
// parts, not two, so an unsubscribe or offers token does not even parse here.
//
// A click MAC covers the destination URL, byte for byte. That is what stops
// the redirect from being an open redirect: a valid token for one link cannot
// be pointed anywhere else.

export const OPEN_MAC_PREFIX = "open:";
export const CLICK_MAC_PREFIX = "click:";

export type ParsedTrackingToken = {
  prospectId: number;
  trackingId: string;
  mac: string;
};

const TRACKING_ID = /^[0-9a-f]{16}$/;
const PROSPECT_ID = /^[1-9][0-9]{0,15}$/;
const MAC = /^[0-9a-f]{64}$/;

function hmacHex(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

/** hex(HMAC_SHA256(secret, `open:${prospectId}:${tid}:${emailKey(email)}`)). */
export function openMac(
  prospectId: number | string,
  trackingId: string,
  email: string,
  secret: string,
): string {
  return hmacHex(secret, `${OPEN_MAC_PREFIX}${prospectId}:${trackingId}:${emailKey(email)}`);
}

/** hex(HMAC_SHA256(secret, `click:${prospectId}:${tid}:${emailKey(email)}:${url}`)). */
export function clickMac(
  prospectId: number | string,
  trackingId: string,
  email: string,
  url: string,
  secret: string,
): string {
  return hmacHex(
    secret,
    `${CLICK_MAC_PREFIX}${prospectId}:${trackingId}:${emailKey(email)}:${url}`,
  );
}

function encode(prospectId: number | string, trackingId: string, mac: string): string {
  return Buffer.from(`${prospectId}.${trackingId}.${mac}`, "utf8").toString("base64url");
}

/** The token in the open pixel's URL, `<base>/api/t/o/<token>`. */
export function mintOpenToken(
  prospectId: number | string,
  trackingId: string,
  email: string,
  secret: string,
): string {
  return encode(prospectId, trackingId, openMac(prospectId, trackingId, email, secret));
}

/** The token in a tracked link, `<base>/api/t/c/<token>?u=<encoded url>`. */
export function mintClickToken(
  prospectId: number | string,
  trackingId: string,
  email: string,
  url: string,
  secret: string,
): string {
  return encode(prospectId, trackingId, clickMac(prospectId, trackingId, email, url, secret));
}

/** Split a token into claimed id, tracking id and MAC. Structure only: nothing
 *  here proves the token is genuine. Null on anything malformed, so a garbage
 *  token costs one base64 decode and no database round trip. */
export function parseTrackingToken(token: string): ParsedTrackingToken | null {
  if (!token || token.length > 512) return null;
  // Buffer.from skips characters it does not recognise; check the alphabet first.
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;

  const parts = Buffer.from(token, "base64url").toString("utf8").split(".");
  if (parts.length !== 3) return null;
  const [idPart, trackingId, mac] = parts;

  if (!PROSPECT_ID.test(idPart)) return null;
  const prospectId = Number(idPart);
  if (!Number.isSafeInteger(prospectId)) return null;
  if (!TRACKING_ID.test(trackingId)) return null;
  if (!MAC.test(mac)) return null;

  return { prospectId, trackingId, mac };
}

/** Verify a parsed open token against the address stored for that prospect. */
export function verifyOpenToken(
  parsed: ParsedTrackingToken,
  storedEmail: string,
  secret: string,
): boolean {
  return macMatches(
    parsed.mac,
    openMac(parsed.prospectId, parsed.trackingId, storedEmail, secret),
  );
}

/** Verify a parsed click token against the stored address and the exact `u`. */
export function verifyClickToken(
  parsed: ParsedTrackingToken,
  storedEmail: string,
  url: string,
  secret: string,
): boolean {
  return macMatches(
    parsed.mac,
    clickMac(parsed.prospectId, parsed.trackingId, storedEmail, url, secret),
  );
}

/** True only for an absolute http(s) URL that can go in a Location header as
 *  it stands: printable ASCII, no whitespace, a real host. Anything else is
 *  never redirected to, however it was signed. */
export function isTrackableUrl(url: string | null | undefined): url is string {
  if (!url || url.length > 2048) return false;
  if (!/^[\x21-\x7e]+$/.test(url)) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !!parsed.hostname;
  } catch {
    return false;
  }
}
