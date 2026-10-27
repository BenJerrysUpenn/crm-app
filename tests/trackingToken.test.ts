import { describe, expect, it } from "vitest";
import {
  clickMac,
  isTrackableUrl,
  mintClickToken,
  mintOpenToken,
  openMac,
  parseTrackingToken,
  verifyClickToken,
  verifyOpenToken,
} from "@/lib/outreach/trackingToken";
import { mintUnsubscribeToken } from "@/lib/outreach/unsubscribeToken";
import { mintOffersToken } from "@/lib/outreach/offersToken";

// THE cross-language pin. Catering-Manager's warm_sender tests assert these
// same literals against the sender's mint functions. If one has to change,
// the sender and this endpoint have stopped agreeing: every open is dropped
// and every tracked link is a 404.
const SECRET = "test-secret";
const PROSPECT_ID = 42;
const TID = "0123456789abcdef";
const EMAIL = " Jane.Doe@Example.com ";
const CLICK_URL = "https://crm.withers-ventures.com/offers/abc";

const OPEN_MAC = "09f926b6d70120ce1e5ddb1ad728a295c1a940b84efd1a7cb2d6be52f71d30fb";
const OPEN_TOKEN =
  "NDIuMDEyMzQ1Njc4OWFiY2RlZi4wOWY5MjZiNmQ3MDEyMGNlMWU1ZGRiMWFkNzI4YTI5NWMxYTk0MGI4NGVmZDFhN2NiMmQ2YmU1MmY3MWQzMGZi";
const CLICK_MAC = "59605da8bf51ffc864a3d99260950cccbf23a60909310110998a100938ecf133";
const CLICK_TOKEN =
  "NDIuMDEyMzQ1Njc4OWFiY2RlZi41OTYwNWRhOGJmNTFmZmM4NjRhM2Q5OTI2MDk1MGNjY2JmMjNhNjA5MDkzMTAxMTA5OThhMTAwOTM4ZWNmMTMz";

describe("the pinned vectors", () => {
  it("open MAC is HMAC_SHA256 over `open:<id>:<tid>:<email_key>`", () => {
    expect(openMac(PROSPECT_ID, TID, EMAIL, SECRET)).toBe(OPEN_MAC);
  });

  it("open token matches the sender byte for byte", () => {
    expect(mintOpenToken(PROSPECT_ID, TID, EMAIL, SECRET)).toBe(OPEN_TOKEN);
  });

  it("click MAC is HMAC_SHA256 over `click:<id>:<tid>:<email_key>:<url>`", () => {
    expect(clickMac(PROSPECT_ID, TID, EMAIL, CLICK_URL, SECRET)).toBe(CLICK_MAC);
  });

  it("click token matches the sender byte for byte", () => {
    expect(mintClickToken(PROSPECT_ID, TID, EMAIL, CLICK_URL, SECRET)).toBe(CLICK_TOKEN);
  });

  it("is unpadded base64url of `<id>.<tid>.<mac>`", () => {
    expect(OPEN_TOKEN).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(OPEN_TOKEN, "base64url").toString("utf8")).toBe(
      `42.${TID}.${OPEN_MAC}`,
    );
  });
});

describe("parseTrackingToken", () => {
  it("splits the pinned token into id, tracking id and MAC", () => {
    expect(parseTrackingToken(OPEN_TOKEN)).toEqual({
      prospectId: 42,
      trackingId: TID,
      mac: OPEN_MAC,
    });
  });

  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const mac = "a".repeat(64);

  it.each([
    ["an empty token", ""],
    ["a character outside base64url", "abc$def"],
    ["padding", `${b64(`42.${TID}.${mac}`)}=`],
    ["a zero id", b64(`0.${TID}.${mac}`)],
    ["a leading-zero id", b64(`042.${TID}.${mac}`)],
    ["a 17-digit id", b64(`12345678901234567.${TID}.${mac}`)],
    ["an uppercase tracking id", b64(`42.0123456789ABCDEF.${mac}`)],
    ["a 15-char tracking id", b64(`42.0123456789abcde.${mac}`)],
    ["a 17-char tracking id", b64(`42.0123456789abcdef0.${mac}`)],
    ["a non-hex tracking id", b64(`42.0123456789abcdeg.${mac}`)],
    ["a short MAC", b64(`42.${TID}.${"a".repeat(63)}`)],
    ["an uppercase MAC", b64(`42.${TID}.${"A".repeat(64)}`)],
    ["a fourth part", b64(`42.${TID}.${mac}.x`)],
    ["no tracking id at all", b64(`42.${mac}`)],
    ["an over-long token", "A".repeat(600)],
  ])("rejects %s", (_label, token) => {
    expect(parseTrackingToken(token)).toBeNull();
  });
});

describe("verification", () => {
  const open = parseTrackingToken(OPEN_TOKEN)!;
  const click = parseTrackingToken(CLICK_TOKEN)!;

  it("accepts the stored address in any casing or padding", () => {
    expect(verifyOpenToken(open, "JANE.DOE@example.com", SECRET)).toBe(true);
    expect(verifyClickToken(click, "jane.doe@example.com  ", CLICK_URL, SECRET)).toBe(true);
  });

  it("rejects another address, another secret, or a swapped tracking id", () => {
    expect(verifyOpenToken(open, "someone@example.com", SECRET)).toBe(false);
    expect(verifyOpenToken(open, EMAIL, "rekeyed")).toBe(false);
    expect(
      verifyOpenToken({ ...open, trackingId: "fedcba9876543210" }, EMAIL, SECRET),
    ).toBe(false);
    expect(verifyOpenToken({ ...open, prospectId: 43 }, EMAIL, SECRET)).toBe(false);
  });

  it("binds a click token to its exact destination", () => {
    expect(verifyClickToken(click, EMAIL, `${CLICK_URL}/`, SECRET)).toBe(false);
    expect(verifyClickToken(click, EMAIL, "https://evil.example/", SECRET)).toBe(false);
    expect(verifyClickToken(click, EMAIL, CLICK_URL.toUpperCase(), SECRET)).toBe(false);
  });
});

describe("purpose separation", () => {
  it("an open token does not verify as a click token, and the reverse", () => {
    const open = parseTrackingToken(OPEN_TOKEN)!;
    const click = parseTrackingToken(CLICK_TOKEN)!;
    expect(verifyClickToken(open, EMAIL, CLICK_URL, SECRET)).toBe(false);
    expect(verifyClickToken(open, EMAIL, "", SECRET)).toBe(false);
    expect(verifyOpenToken(click, EMAIL, SECRET)).toBe(false);
  });

  it("an unsubscribe or offers token does not even parse", () => {
    expect(parseTrackingToken(mintUnsubscribeToken(PROSPECT_ID, EMAIL, SECRET))).toBeNull();
    expect(parseTrackingToken(mintOffersToken(PROSPECT_ID, EMAIL, SECRET))).toBeNull();
  });
});

describe("isTrackableUrl", () => {
  it.each([
    CLICK_URL,
    "http://example.com",
    "HTTPS://Example.com/path?q=1#frag",
  ])("accepts %s", (url) => {
    expect(isTrackableUrl(url)).toBe(true);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["relative", "/offers/abc"],
    ["protocol-relative", "//evil.example/"],
    ["javascript:", "javascript:alert(1)"],
    ["mailto:", "mailto:someone@example.com"],
    ["data:", "data:text/html,hi"],
    ["ftp:", "ftp://example.com/file"],
    ["no host", "https://"],
    ["a backslash authority", "https:\\\\evil.example"],
    ["whitespace", " https://example.com"],
    ["a control character", "https://example.com/\r\nSet-Cookie: x=1"],
    // Location must be a header-safe byte string; the sender percent-encodes.
    ["a raw non-ASCII character", "https://example.com/caf\u00e9"],
  ])("rejects %s", (_label, url) => {
    expect(isTrackableUrl(url)).toBe(false);
  });
});
