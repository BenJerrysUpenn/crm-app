import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RecipientPageFrames from "@/components/emailCampaignsPrototype/RecipientPageFrames";
import { UNSUBSCRIBED_HTML, UNSUBSCRIBE_CONFIRM_HTML } from "@/lib/outreach/unsubscribePage";

export const dynamic = "force-dynamic";

// /email-campaigns/preview/unsubscribe — PROTOTYPE (v6). The warm lane's REAL
// opt-out page: the same markup /api/unsubscribe/[token] serves (shared from
// lib/outreach/unsubscribePage.ts), shown with a fake token. No token is
// verified, no endpoint is called and nothing is written.
export default async function UnsubscribePreviewPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <RecipientPageFrames
      title="Opt-out page (warm)"
      intro={
        <>
          <p>
            This is the real page the warm lane&apos;s Unsubscribe link opens, served by{" "}
            <code className="font-mono">/api/unsubscribe/&lt;token&gt;</code> (live since 09-26). Here it is shown with
            a fake token (<code className="font-mono">preview-token</code>): nothing is verified, posted or written.
          </p>
          <p>
            A mail app&apos;s own one-click &ldquo;Unsubscribe&rdquo; button (RFC 8058) posts straight to the same
            address and shows the person no page.
          </p>
          <p className="font-medium">Cold opt-outs use Apollo&apos;s hosted unsubscribe page (not customisable by us).</p>
        </>
      }
      frames={[
        {
          label: "1. They click Unsubscribe in the email",
          caption: "GET: nothing is written yet, because link scanners open links too",
          html: UNSUBSCRIBE_CONFIRM_HTML,
        },
        {
          label: "2. After they press the button",
          caption: "POST: the address is suppressed (not in this preview)",
          html: UNSUBSCRIBED_HTML,
        },
      ]}
    />
  );
}
