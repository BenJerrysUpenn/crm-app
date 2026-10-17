import type { OutgoingEmail } from "@/lib/coverageReminderCli";

// Send a plain-text email through the Gmail API over HTTPS (bj-finance #709).
// DigitalOcean blocks SMTP, so the droplet sends this way. No library: a
// refresh-token exchange, then users/me/messages/send, the same two calls as
// bj-finance modules/gmail_api_send.py and Catering-Manager
// outreach/warm_sender.py.
//
// Credentials are the OUTREACH_GMAIL_* keys already in
// /etc/bj-finance/outreach.env on the droplet. The token's scope is
// gmail.send only.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

function required(env: Record<string, string | undefined>, name: string): string {
  // Pasted tokens sometimes carry whitespace or a line break; Google rejects them.
  const value = (env[name] ?? "").replace(/\s+/g, "");
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function check(response: Response, what: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(`Gmail ${what} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** RFC 5322 message, body base64 so the en dash in a time range survives. */
function rawMessage(email: OutgoingEmail): string {
  const headers = [
    ...(email.from ? [`From: ${email.from}`] : []),
    `To: ${email.to.join(", ")}`,
    `Subject: ${email.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(email.body, "utf8").toString("base64");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

export function gmailApiSender(
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch = fetch,
): (email: OutgoingEmail) => Promise<void> {
  return async (email) => {
    const form = new URLSearchParams({
      client_id: required(env, "OUTREACH_GMAIL_CLIENT_ID"),
      client_secret: required(env, "OUTREACH_GMAIL_CLIENT_SECRET"),
      refresh_token: required(env, "OUTREACH_GMAIL_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    });
    const token = (await check(
      await fetchFn(TOKEN_URL, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) }),
      "token exchange",
    )) as { access_token: string };

    await check(
      await fetchFn(SEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: rawMessage(email) }),
        signal: AbortSignal.timeout(30_000),
      }),
      "send",
    );
  };
}
