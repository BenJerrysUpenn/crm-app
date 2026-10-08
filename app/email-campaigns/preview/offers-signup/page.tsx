import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RecipientPageFrames from "@/components/emailCampaignsPrototype/RecipientPageFrames";
import { OFFERS_CONSENT_TEXT, offersConfirmHtml, offersSignedUpHtml } from "@/lib/outreach/offersPage";

export const dynamic = "force-dynamic";

const SAMPLE_EMAIL = "jordan.rivera@example.com";

// /email-campaigns/preview/offers-signup — preview of the page someone lands
// on after clicking "Yes, send me offers". Served for real at /offers/<token>
// (bj-finance #425); here the address is a sample and nothing is written.
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
            The page for the &ldquo;Yes, send me offers&rdquo; footer link, served at /offers/&lt;token&gt;. This
            preview uses a sample address and writes nothing.
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
          html: offersConfirmHtml(SAMPLE_EMAIL),
        },
        {
          label: "2. After they press the button",
          caption: "the confirmation, with the consent statement we keep",
          html: offersSignedUpHtml(now, SAMPLE_EMAIL),
        },
      ]}
    />
  );
}
