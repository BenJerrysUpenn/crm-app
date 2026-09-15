import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  emailKey,
  macMatches,
  mintUnsubscribeToken,
  parseUnsubscribeToken,
  unsubscribeMac,
  verifyUnsubscribeToken,
} from "@/lib/outreach/unsubscribeToken";

const SECRET = "test-secret-not-a-real-one";

describe("emailKey", () => {
  it("trims and lowercases", () => {
    expect(emailKey("  Someone@Example.COM ")).toBe("someone@example.com");
  });
});

describe("unsubscribeMac", () => {
  // The contract is "hex(HMAC_SHA256(secret, id + ':' + lowercase(email)))".
  // Recomputed here from node:crypto directly rather than from the module, so
  // the test would fail if the module changed the MAC input shape.
  it("is HMAC_SHA256 over `<id>:<email_key>`", () => {
    const expected = createHmac("sha256", SECRET)
      .update("123:someone@example.com")
      .digest("hex");
    expect(unsubscribeMac(123, "Someone@Example.com", SECRET)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with the id, the address and the secret", () => {
    const base = unsubscribeMac(1, "a@b.com", SECRET);
    expect(unsubscribeMac(2, "a@b.com", SECRET)).not.toBe(base);
    expect(unsubscribeMac(1, "c@b.com", SECRET)).not.toBe(base);
    expect(unsubscribeMac(1, "a@b.com", "other")).not.toBe(base);
  });
});

describe("mintUnsubscribeToken", () => {
  it("is unpadded base64url of `<id>.<mac>`", () => {
    const token = mintUnsubscribeToken(123, "someone@example.com", SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");
    expect(Buffer.from(token, "base64url").toString("utf8")).toBe(
      `123.${unsubscribeMac(123, "someone@example.com", SECRET)}`,
    );
  });

  // The Python that outreach/warm_sender.py will carry, transliterated. If
  // this ever fails, docs/unsubscribe.md is wrong and the sender will mint
  // tokens this endpoint rejects.
  it("matches the documented Python recipe byte for byte", () => {
    const prospectId = 25386;
    const email = "  Pino@Example.com  ";
    const mac = createHmac("sha256", Buffer.from(SECRET, "utf8"))
      .update(Buffer.from(`${prospectId}:${email.trim().toLowerCase()}`, "utf8"))
      .digest("hex");
    const payload = Buffer.from(`${prospectId}.${mac}`, "utf8");
    const pythonEquivalent = payload
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(mintUnsubscribeToken(prospectId, email, SECRET)).toBe(
      pythonEquivalent,
    );
  });
});

describe("parseUnsubscribeToken", () => {
  it("round-trips a minted token", () => {
    const token = mintUnsubscribeToken(42, "someone@example.com", SECRET);
    expect(parseUnsubscribeToken(token)).toEqual({
      prospectId: 42,
      mac: unsubscribeMac(42, "someone@example.com", SECRET),
    });
  });

  const rejected: Array<[string, string]> = [
    ["empty", ""],
    ["padded base64", Buffer.from("1.a").toString("base64") + "="],
    [
      "characters outside the base64url alphabet",
      "abc$def",
    ],
    ["not base64 of anything with a dot", Buffer.from("nodot").toString("base64url")],
    ["leading dot", Buffer.from(".".padEnd(65, "a")).toString("base64url")],
    ["non-numeric id", Buffer.from(`x.${"a".repeat(64)}`).toString("base64url")],
    ["zero id", Buffer.from(`0.${"a".repeat(64)}`).toString("base64url")],
    ["negative id", Buffer.from(`-1.${"a".repeat(64)}`).toString("base64url")],
    ["short mac", Buffer.from(`1.${"a".repeat(63)}`).toString("base64url")],
    ["long mac", Buffer.from(`1.${"a".repeat(65)}`).toString("base64url")],
    ["uppercase mac", Buffer.from(`1.${"A".repeat(64)}`).toString("base64url")],
    ["non-hex mac", Buffer.from(`1.${"z".repeat(64)}`).toString("base64url")],
    ["absurdly long", "a".repeat(600)],
  ];

  it.each(rejected)("rejects %s", (_label, token) => {
    expect(parseUnsubscribeToken(token)).toBeNull();
  });
});

describe("macMatches", () => {
  it("is true only for an exact match", () => {
    const mac = unsubscribeMac(1, "a@b.com", SECRET);
    expect(macMatches(mac, mac)).toBe(true);
    expect(macMatches(mac, unsubscribeMac(2, "a@b.com", SECRET))).toBe(false);
  });

  it("returns false rather than throwing on a length mismatch", () => {
    expect(macMatches("short", "a".repeat(64))).toBe(false);
  });
});

describe("verifyUnsubscribeToken", () => {
  const token = mintUnsubscribeToken(7, "person@example.com", SECRET);
  const parsed = parseUnsubscribeToken(token)!;

  it("accepts the stored address in any casing or padding", () => {
    expect(verifyUnsubscribeToken(parsed, "person@example.com", SECRET)).toBe(true);
    expect(verifyUnsubscribeToken(parsed, " PERSON@Example.com ", SECRET)).toBe(true);
  });

  it("rejects a different address, or a different secret", () => {
    expect(verifyUnsubscribeToken(parsed, "someone@example.com", SECRET)).toBe(false);
    expect(verifyUnsubscribeToken(parsed, "person@example.com", "rekeyed")).toBe(false);
  });

  it("rejects a token whose id was swapped for another prospect's", () => {
    // The MAC covers the id, so re-pointing a valid token at a different
    // prospect cannot work even when that prospect's address is known.
    const forged = parseUnsubscribeToken(
      Buffer.from(`8.${parsed.mac}`, "utf8").toString("base64url"),
    )!;
    expect(verifyUnsubscribeToken(forged, "person@example.com", SECRET)).toBe(false);
  });
});
