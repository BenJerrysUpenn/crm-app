// Plain-text email via Resend. A no-op (returns false) when RESEND_API_KEY is
// unset so the app runs day one and you wire the key in later.
//
// Attachments (bj-finance #210): the receipts@ sends of Travel Reimbursements
// carry the uploaded Receipts and Lyft ride reports. Resend takes each as
// { filename, content } with the bytes base64-encoded, up to 40 MB per email
// after encoding.

export type EmailAttachment = { filename: string; content: Uint8Array };

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendEmail(to: string, subject: string, text: string, attachments: EmailAttachment[] = []) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const from =
    process.env.NOTIFICATIONS_FROM_EMAIL || "Withers Time <onboarding@resend.dev>";
  const payload: Record<string, unknown> = { from, to, subject, text };
  if (attachments.length)
    payload.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content).toString("base64"),
    }));
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}
