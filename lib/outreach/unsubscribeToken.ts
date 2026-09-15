import { createHmac, timingSafeEqual } from "node:crypto";

// One-click unsubscribe tokens (bj-finance #440).
//
// The whole contract, stated once, in one file, because two codebases have to
// agree on it byte for byte: this endpoint verifies the token and
// Catering-Manager's outreach/warm_sender.py mints it. `docs/unsubscribe.md`
// is the prose version; if the two disagree, this file is the truth and the
// doc gets fixed.
//
//   payload = `${prospect_id}.${hex(HMAC_SHA256(secret, mac_input))}`
//   mac_input = `${prospect_id}:${email_key}`
//   email_key = email, whitespace-trimmed, lowercased
//   token = base64url(payload), unpadded
//
// Pure and dependency-free (node:crypto only) so it can be unit-tested and so
// the sender can be transliterated from it without reading the route handler.

/** The email form that goes into the MAC. Trimmed and lowercased, matching
 *  the `lower(btrim(email))` the outreach SQL uses as its key everywhere. */
export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/** hex(HMAC_SHA256(secret, `${prospectId}:${emailKey(email)}`)). */
export function unsubscribeMac(
  prospectId: number | string,
  email: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${prospectId}:${emailKey(email)}`)
    .digest("hex");
}

/** The token that goes in a List-Unsubscribe URL. */
export function mintUnsubscribeToken(
  prospectId: number | string,
  email: string,
  secret: string,
): string {
  const payload = `${prospectId}.${unsubscribeMac(prospectId, email, secret)}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

export type ParsedToken = { prospectId: number; mac: string };

/** Split a token into its claimed id and MAC. Structure only — nothing here
 *  proves the token is genuine; `macMatches` does that, after the id has been
 *  used to look the stored address up. Returns null on anything malformed, so
 *  a garbage token costs one base64 decode and no database round trip. */
export function parseUnsubscribeToken(token: string): ParsedToken | null {
  if (!token || token.length > 512) return null;
  // base64url only. Buffer.from is famously lenient (it skips characters it
  // does not recognise), so reject the alphabet ourselves first.
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;

  let payload: string;
  try {
    payload = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const dot = payload.indexOf(".");
  if (dot <= 0) return null;
  const idPart = payload.slice(0, dot);
  const mac = payload.slice(dot + 1);

  // Ids are bigint in Postgres but every live prospect id is small; anything
  // that is not a plain positive integer inside the safe range is not one of
  // ours and must not reach a query.
  if (!/^[1-9][0-9]{0,15}$/.test(idPart)) return null;
  const prospectId = Number(idPart);
  if (!Number.isSafeInteger(prospectId)) return null;

  if (!/^[0-9a-f]{64}$/.test(mac)) return null;

  return { prospectId, mac };
}

/** Constant-time comparison of a presented MAC against the expected one. */
export function macMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Verify a parsed token against the address stored for that prospect. */
export function verifyUnsubscribeToken(
  parsed: ParsedToken,
  storedEmail: string,
  secret: string,
): boolean {
  return macMatches(
    parsed.mac,
    unsubscribeMac(parsed.prospectId, storedEmail, secret),
  );
}
