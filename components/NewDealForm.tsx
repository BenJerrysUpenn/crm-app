"use client";

import { useRouter } from "next/navigation";
import GenerateDealForm from "@/components/callDesk/GenerateDealForm";

/**
 * The manual "New deal" entry point (/deals/new).
 *
 * It is the call desk's guided form with no prospect behind it — see
 * `GenerateDealForm`, which grows a source picker and a duplicate warning and
 * relaxes its required set when `prospect` is null. Deliberately NOT a second
 * form: the two intakes write the same row through the same builder, and a
 * copy would drift the moment a package or an event type changed.
 *
 * The form renders as a full-screen overlay, so this component has no chrome
 * of its own. Closing or finishing goes back to the board, which is where the
 * new deal now is.
 */
export default function NewDealForm({ callerEmail }: { callerEmail: string }) {
  const router = useRouter();

  function backToBoard() {
    router.push("/");
    // The board is a server component reading `deals`; without this it would
    // render from the router cache and the new deal would be missing.
    router.refresh();
  }

  return (
    <GenerateDealForm
      prospect={null}
      callerEmail={callerEmail}
      onClose={backToBoard}
      // NOT a navigation: the form shows "Deal #N created" and what happened
      // to the quote and to Salesforce, and somebody typing in a voicemail
      // needs to read that. Its own button then calls onClose.
      onCreated={() => router.refresh()}
    />
  );
}
