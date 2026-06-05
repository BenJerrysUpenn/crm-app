import type { SupabaseClient } from "@supabase/supabase-js";
import { isTerminal, type Stage } from "@/lib/stages";

export type BoomerangReason = "quote_reply" | "deposit_due" | "balance_due";

export type StagePatch = {
  stage: Stage;
  boomerang_reason: BoomerangReason | null;
  is_active: number;
  updated_at: string;
  payment_status?: string;
};

// The DB CHECK constraint on (stage, boomerang_reason) requires these pairs.
// Catering's Python automation uses the same mapping on its own writes, so
// the web app stays in lockstep when a user moves a card.
function boomerangForStage(stage: Stage): BoomerangReason | null {
  switch (stage) {
    case "Sent Quote":
      return "quote_reply";
    case "Booked Unpaid":
      return "deposit_due";
    case "Booked Paid":
      return "balance_due";
    default:
      return null;
  }
}

// Build the exact patch the database expects for a stage change.
// Used by both the Kanban drag handler and the detail-drawer dropdown.
//
// `currentPaymentStatus` lets us tag a deposit landing automatically when
// the user moves a card into Booked Paid: that move only makes sense
// when the deposit has come in, so payment_status flips from "None"/null
// to "Deposit Paid". A row that's already "Paid in Full" is left alone.
export function buildStagePatch(
  newStage: Stage,
  currentPaymentStatus?: string | null,
): StagePatch {
  const patch: StagePatch = {
    stage: newStage,
    boomerang_reason: boomerangForStage(newStage),
    is_active: isTerminal(newStage) ? 0 : 1,
    updated_at: new Date().toISOString(),
  };
  if (
    newStage === "Booked Paid" &&
    (currentPaymentStatus == null ||
      currentPaymentStatus === "" ||
      currentPaymentStatus === "None")
  ) {
    patch.payment_status = "Deposit Paid";
  }
  return patch;
}

export async function writeStageChange(
  supabase: SupabaseClient,
  dealId: number,
  patch: StagePatch,
) {
  return supabase.from("deals").update(patch).eq("id", dealId);
}
