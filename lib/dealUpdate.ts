import type { SupabaseClient } from "@supabase/supabase-js";
import { isTerminal, type Stage } from "@/lib/stages";

export type StagePatch = {
  stage: Stage;
  is_active: number;
  updated_at: string;
  payment_status?: string;
};

// Build the exact patch the database expects for a stage change.
// Used by the Kanban drag handler, the calendar, the detail-drawer dropdown,
// and the call desk's "close deal as lost".
//
// `deals.boomerang_reason` is deliberately absent. The automatic boomerang
// follow-up was retired by bj-finance #333 (executed in Catering-Manager
// #339/#340), and migration 018b drops the column outright — writing it here
// would make every stage change fail with "column boomerang_reason does not
// exist". See bj-finance #466.
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
