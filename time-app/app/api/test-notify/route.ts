import { getProfile } from "@/lib/auth";
import { notify, emailForUser } from "@/lib/notify";
import { NextResponse } from "next/server";

// Fires a real notification to the signed-in user through the normal pipeline
// (in-app bell + email/SMS, respecting their prefs). Handy for verifying setup.
export async function POST() {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const email = await emailForUser(profile.id);
  const stamp = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const result = await notify({
    userId: profile.id,
    type: "test",
    title: "Test notification",
    body: `This is a test sent at ${stamp}. If you got it, notifications work.`,
    email,
    phone: profile.phone,
  });

  return NextResponse.json({
    ok: true,
    hasEmail: !!email,
    hasPhone: !!profile.phone,
    sent_email: result.sent_email,
    sent_sms: result.sent_sms,
    note:
      "sent_email/sent_sms=false can mean the channel isn't configured (Resend/Twilio) or you have it toggled off. The bell entry is always written.",
  });
}
