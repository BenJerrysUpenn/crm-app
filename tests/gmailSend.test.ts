// The Gmail API mailer the coverage reminder sends through (bj-finance #709):
// a refresh-token exchange, then users/me/messages/send, over plain fetch.
// SMTP is blocked on the droplet, so this is the only way out.

import { describe, expect, it } from "vitest";
import { gmailApiSender } from "@/lib/gmailSend";

const ENV = {
  OUTREACH_GMAIL_CLIENT_ID: "client-id",
  OUTREACH_GMAIL_CLIENT_SECRET: "client-secret",
  // Pasted tokens sometimes carry a line break; it must not reach Google.
  OUTREACH_GMAIL_REFRESH_TOKEN: "refresh-\ntoken",
};

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { calls, fetchFn: fetchFn as typeof fetch };
}

function decodeRaw(call: Call): string {
  const { raw } = JSON.parse(String(call.init.body));
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("gmailApiSender", () => {
  it("exchanges the refresh token, then sends a plain-text message", async () => {
    const { calls, fetchFn } = fakeFetch([
      { status: 200, body: { access_token: "access-1" } },
      { status: 200, body: { id: "msg-1" } },
    ]);
    const send = gmailApiSender(ENV, fetchFn);
    await send({
      from: "sender@example.test",
      to: ["a@example.test", "b@example.test"],
      subject: "Schedule gaps",
      body: "Sat Oct 24, 2:00–6:00 PM\n",
    });

    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(form)).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-token",
      grant_type: "refresh_token",
    });

    expect(calls[1].url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer access-1");
    const raw = decodeRaw(calls[1]);
    expect(raw).toContain("From: sender@example.test\r\n");
    expect(raw).toContain("To: a@example.test, b@example.test\r\n");
    expect(raw).toContain("Subject: Schedule gaps\r\n");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8\r\n");
    const body = raw.split("\r\n\r\n")[1];
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Sat Oct 24, 2:00–6:00 PM\n");
  });

  it("declares the body base64 MIME, so a mail client shows the text and not the encoding", async () => {
    // Without these two headers the recipient reads the raw base64 string.
    const { calls, fetchFn } = fakeFetch([
      { status: 200, body: { access_token: "a" } },
      { status: 200, body: { id: "m" } },
    ]);
    await gmailApiSender(ENV, fetchFn)({ to: ["x@example.test"], subject: "s", body: "Sat Oct 24, 2:00–6:00 PM\n" });
    const headers = decodeRaw(calls[1]).split("\r\n\r\n")[0].split("\r\n");
    expect(headers).toContain("MIME-Version: 1.0");
    expect(headers).toContain("Content-Transfer-Encoding: base64");
  });

  it("leaves From off when none is given, so Gmail uses the account's own address", async () => {
    const { calls, fetchFn } = fakeFetch([
      { status: 200, body: { access_token: "a" } },
      { status: 200, body: { id: "m" } },
    ]);
    await gmailApiSender(ENV, fetchFn)({ to: ["x@example.test"], subject: "s", body: "b" });
    expect(decodeRaw(calls[1])).not.toContain("From:");
  });

  it("fails on a missing credential without calling Google", async () => {
    const { calls, fetchFn } = fakeFetch([]);
    const send = gmailApiSender({ ...ENV, OUTREACH_GMAIL_REFRESH_TOKEN: "" }, fetchFn);
    await expect(send({ to: ["x@example.test"], subject: "s", body: "b" })).rejects.toThrow(
      "OUTREACH_GMAIL_REFRESH_TOKEN is not set",
    );
    expect(calls).toEqual([]);
  });

  it("fails with the HTTP status when the token exchange is refused", async () => {
    const { fetchFn } = fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]);
    await expect(gmailApiSender(ENV, fetchFn)({ to: ["x@example.test"], subject: "s", body: "b" })).rejects.toThrow(
      /token exchange failed: HTTP 400.*invalid_grant/,
    );
  });

  it("fails with the HTTP status when the send is refused", async () => {
    const { fetchFn } = fakeFetch([
      { status: 200, body: { access_token: "a" } },
      { status: 403, body: { error: { message: "Insufficient Permission" } } },
    ]);
    await expect(gmailApiSender(ENV, fetchFn)({ to: ["x@example.test"], subject: "s", body: "b" })).rejects.toThrow(
      /send failed: HTTP 403.*Insufficient Permission/,
    );
  });
});
