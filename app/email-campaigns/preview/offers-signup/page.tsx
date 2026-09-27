import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RecipientPageFrames from "@/components/emailCampaignsPrototype/RecipientPageFrames";
import {
  OFFERS_CONSENT_TEXT,
  offersConfirmHtml,
  offersSignedUpHtml,
} from "@/lib/emailCampaignsPrototype/offersSignupPage";

export const dynamic = "force-dynamic";

// /email-campaigns/preview/offers-signup — PROTOTYPE (v6). The page someone
// lands on after clicking "Yes, send me offers". Proposed: nothing serves it
// for real, the address is a sample and nothing is written.
export default async function OffersSignupPreviewPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const now = new Date();
  return (
    <RecipientPageFrames
      title="Opt-in page: seasonal menu with offers"
      intro={
        <>
          <p>
            Proposed page for the &ldquo;Yes, send me offers&rdquo; footer link. Nothing serves it yet: this preview
            uses a sample address and writes nothing.
          </p>
          <p>
            Like the unsubscribe page, it records consent only when the person presses the button (step 1), because
            mail providers and link scanners open every link in an email.
          </p>
          <p>
            Stored as proof of opt-in: the statement below, the address, and the date and time the button was
            pressed. <span className="italic">&ldquo;{OFFERS_CONSENT_TEXT}&rdquo;</span>
          </p>
        </>
      }
      frames={[
        {
          label: "1. They click “Yes, send me offers” in the email",
          caption: "nothing is recorded yet",
          html: offersConfirmHtml(),
        },
        {
          label: "2. After they press the button",
          caption: "the confirmation, with the consent statement we keep",
          html: offersSignedUpHtml(now),
        },
      ]}
    />
  );
}
