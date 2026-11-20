// Plain-text email through Resend (lib/email.ts), now with attachments for the
// receipts@ sends of Travel Reimbursements (bj-finance #210).
//
//   npm test

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { sendEmail } from "./email.ts";

const realFetch = globalThis.fetch;
let sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
// What Resend answers: a status, or "down" for a request that never reaches it.
let resend: number | "down" = 200;

beforeEach(() => {
  sent = [];
  resend = 200;
  process.env.RESEND_API_KEY = "re_test";
  process.env.NOTIFICATIONS_FROM_EMAIL = "Withers Time <time@withers-ventures.com>";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (resend === "down") throw new TypeError("fetch failed");
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: resend });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFICATIONS_FROM_EMAIL;
});

test("sends plain text from NOTIFICATIONS_FROM_EMAIL, with no attachments field when there are none", async () => {
  assert.equal(await sendEmail("a@example.test", "Hi", "Body"), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.deepEqual(sent[0].body, { from: "Withers Time <time@withers-ventures.com>", to: "a@example.test", subject: "Hi", text: "Body" });
});

test("attachments go to Resend as base64 content with their file names", async () => {
  const ok = await sendEmail("receipts@withers-ventures.com", "S", "T", [
    { filename: "receipt-1.jpg", content: Buffer.from("jpeg bytes") },
    { filename: "receipt-2.pdf", content: Buffer.from("%PDF") },
  ]);
  assert.equal(ok, true);
  assert.deepEqual(sent[0].body.attachments, [
    { filename: "receipt-1.jpg", content: Buffer.from("jpeg bytes").toString("base64") },
    { filename: "receipt-2.pdf", content: Buffer.from("%PDF").toString("base64") },
  ]);
});

test("is a no-op without RESEND_API_KEY", async () => {
  delete process.env.RESEND_API_KEY;
  assert.equal(await sendEmail("a@example.test", "Hi", "Body"), false);
  assert.equal(sent.length, 0);
});

test("is false when Resend refuses the email or cannot be reached, so the caller does not count it sent", async () => {
  resend = 422;
  assert.equal(await sendEmail("receipts@withers-ventures.com", "S", "T", [{ filename: "r.jpg", content: Buffer.from("x") }]), false);
  resend = "down";
  assert.equal(await sendEmail("receipts@withers-ventures.com", "S", "T"), false);
});
