import type { SupabaseClient } from "@supabase/supabase-js";
import { isTerminal, type Stage } from "@/lib/stages";

export type StagePatch = {
  stage: Stage;
  boomerang_reason: null;
  is_active: number;
  updated_at: string;
};

// Build the exact 4-field patch the database expects for a stage change.
// Used by both the Kanban drag handler and the detail-drawer dropdown.
export function buildStagePatch(newStage: Stage): StagePatch {
  return {
    stage: newStage,
    boomerang_reason: null,
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
