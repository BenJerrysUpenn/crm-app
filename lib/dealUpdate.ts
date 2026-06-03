import type { SupabaseClient } from "@supabase/supabase-js";
import { isTerminal, type Stage } from "@/lib/stages";

export type BoomerangReason = "quote_reply" | "deposit_due" | "balance_due";

export type StagePatch = {
  stage: Stage;
  boomerang_reason: BoomerangReason | null;
  is_active: number;
  updated_at: string;
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

// Build the exact 4-field patch the database expects for a stage change.
// Used by both the Kanban drag handler and the detail-drawer dropdown.
export function buildStagePatch(newStage: Stage): StagePatch {
  return {
    stage: newStage,
    boomerang_reason: boomerangForStage(newStage),
    is_active: isTerminal(newStage) ? 0 : 1,
    updated_at: new Date().toISOString(),
  };
}

export async function writeStageChange(
  supabase: SupabaseClient,
  dealId: number,
  patch: StagePatch,
) {
  return supabase.from("deals").update(patch).eq("id", dealId);
}
