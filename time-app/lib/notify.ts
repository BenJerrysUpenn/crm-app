// Notification fan-out: writes an in-app row and best-effort email + SMS.
// Email (Resend) and SMS (Twilio) are no-ops when their env vars are unset,
// so the app runs day one and you wire in keys later.
import { createAdminClient } from "@/lib/supabase/admin";

type NotifyArgs = {
  userId: string;
  type: string;
  title: string;
  body?: string;
  email?: string | null;
  phone?: string | null;
};

async function sendEmail(to: string, subject: string, text: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const from =
    process.env.NOTIFICATIONS_FROM_EMAIL || "Withers Time <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendSms(to: string, body: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return false;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function notify(args: NotifyArgs) {
  const { userId, type, title, body, email, phone } = args;
  const text = body ? `${title}\n\n${body}` : title;

  const supabase = createAdminClient();

  // Respect the recipient's preferences. Absent key = on (opt-out model).
  let prefs: Record<string, boolean> = {};
  try {
    const { data } = await supabase
      .from("profiles")
      .select("notif_prefs")
      .eq("id", userId)
      .single();
    prefs = (data?.notif_prefs as Record<string, boolean>) ?? {};
  } catch {
    prefs = {};
  }
  // If this alert type is switched off, send nothing at all.
  if (prefs[type] === false) {
    return { sent_email: false, sent_sms: false, skipped: true };
  }

  const sent_email = email && prefs.email !== false ? await sendEmail(email, title, text) : false;
  const sent_sms = phone && prefs.sms !== false ? await sendSms(phone, text) : false;

  await supabase.from("notifications").insert({
    user_id: userId,
    type,
    title,
    body: body ?? null,
    sent_email,
    sent_sms,
  });

  return { sent_email, sent_sms };
}

// Look up a user's email from auth.users (requires service role key).
export async function emailForUser(userId: string): Promise<string | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const supabase = createAdminClient();
    const { data } = await supabase.auth.admin.getUserById(userId);
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}
