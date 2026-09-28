import { describe, expect, it } from "vitest";
import {
  mintOffersToken,
  offersMac,
  parseOffersToken,
  verifyOffersToken,
} from "@/lib/outreach/offersToken";
import {
  mintUnsubscribeToken,
  parseUnsubscribeToken,
  verifyUnsubscribeToken,
} from "@/lib/outreach/unsubscribeToken";

const SECRET = "test-secret-not-a-real-one";

describe("offersMac", () => {
  // An independent literal: HMAC_SHA256(SECRET, "offers:123:someone@example.com")
  // as `openssl dgst -sha256 -hmac` prints it, and the MAC half of the pinned
  // 123 vector below. Fails if the module changes the MAC input shape.
  it("is HMAC_SHA256 over `offers:<id>:<email_key>`", () => {
    expect(offersMac(123, " Someone@Example.com ", SECRET)).toBe(
      "739d835908fa9273509992c699fa985e54783d796a16857393b77a0dd9752fa8",
    );
  });
});

describe("mintOffersToken", () => {
  // THE cross-language pin. Catering-Manager tests/test_warm_sender_offers.py
  // asserts the same two literals against outreach/warm_sender.py's
  // `offers_token`. If either has to change, the sender and this endpoint
  // have stopped agreeing and every "Yes, send me offers" press is a 404.
  it("matches the warm_sender vector byte for byte", () => {
    expect(mintOffersToken(25386, "  Pino@Example.com  ", SECRET)).toBe(
      "MjUzODYuZGM2ZGNlYjZhZGUxODZjZmE2NTJkZmRmZjBjNWVjM2EyNGE5NWYwOGRiZmM1MTJlYTUwNGE4ZDI3OTRmYjMyMA",
    );
    expect(mintOffersToken(123, "Someone@Example.com", SECRET)).toBe(
      "MTIzLjczOWQ4MzU5MDhmYTkyNzM1MDk5OTJjNjk5ZmE5ODVlNTQ3ODNkNzk2YTE2ODU3MzkzYjc3YTBkZDk3NTJmYTg",
    );
  });

  it("is unpadded base64url of `<id>.<mac>`", () => {
    const token = mintOffersToken(123, "someone@example.com", SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url").toString("utf8")).toBe(
      "123.739d835908fa9273509992c699fa985e54783d796a16857393b77a0dd9752fa8",
    );
  });
});

describe("purpose separation from unsubscribe tokens", () => {
  const id = 25386;
  const email = "pino@example.com";

  it("never mints the same token for the same person", () => {
    expect(mintOffersToken(id, email, SECRET)).not.toBe(
      mintUnsubscribeToken(id, email, SECRET),
    );
  });

  it("an unsubscribe token does not verify as an offers token", () => {
    const parsed = parseOffersToken(mintUnsubscribeToken(id, email, SECRET))!;
    expect(parsed).not.toBeNull();
    expect(verifyOffersToken(parsed, email, SECRET)).toBe(false);
  });

  it("an offers token does not verify as an unsubscribe token", () => {
    const parsed = parseUnsubscribeToken(mintOffersToken(id, email, SECRET))!;
    expect(parsed).not.toBeNull();
    expect(verifyUnsubscribeToken(parsed, email, SECRET)).toBe(false);
  });
});

describe("verifyOffersToken", () => {
  const parsed = parseOffersToken(mintOffersToken(7, "person@example.com", SECRET))!;

  it("accepts the stored address in any casing or padding", () => {
    expect(verifyOffersToken(parsed, " PERSON@Example.com ", SECRET)).toBe(true);
  });

  it("rejects a different address, a different secret, or a swapped id", () => {
    expect(verifyOffersToken(parsed, "someone@example.com", SECRET)).toBe(false);
    expect(verifyOffersToken(parsed, "person@example.com", "rekeyed")).toBe(false);
    const swapped = parseOffersToken(
      Buffer.from(`8.${parsed.mac}`, "utf8").toString("base64url"),
    )!;
    expect(verifyOffersToken(swapped, "person@example.com", SECRET)).toBe(false);
  });

  it("parses nothing malformed", () => {
    expect(parseOffersToken("")).toBeNull();
    expect(parseOffersToken("abc$def")).toBeNull();
    // Zero is the warm_sender --test-send-to id: structurally invalid, so a
    // test send's link can only ever 404 and cannot opt the seed address in.
    expect(
      parseOffersToken(Buffer.from(`0.${"a".repeat(64)}`).toString("base64url")),
    ).toBeNull();
  });
});
