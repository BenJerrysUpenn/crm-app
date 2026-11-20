import type { SupabaseClient } from "@supabase/supabase-js";
import { isTerminal, type Stage } from "@/lib/stages";

export type StagePatch = {
  stage: Stage;
  is_active: number;
  updated_at: string;
};

type DealEventRow = {
  deal_id: number;
  field: string;
  old_value: string | null;
  new_value: string;
  at: string;
  actor: string;
  source: string;
};

export type StageChangeResult = {
  /** The move did not happen. */
  error: { message: string } | null;
  /** The move happened and its history did not. Show this to the person. */
  historyError: string | null;
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
// `payment_status` is deliberately absent too. A stage move says nothing about
// money: a person records payment with the card's deposit/paid pill or the
// drawer. Stamping Deposit Paid on a move to Booked Paid put a deposit on a deal
// nobody had paid when it was moved back by hand (bj-finance #750).
export function buildStagePatch(newStage: Stage): StagePatch {
  return {
    stage: newStage,
    is_active: isTerminal(newStage) ? 0 : 1,
    updated_at: new Date().toISOString(),
  };
}

// The one way the CRM moves a deal between stages. Writes the move and its
// deal_events rows, the same rows Catering-Manager's db.update_deal writes.
//
// The old value is read from the row, because what a screen holds can be stale:
// the catering sweep moves deals too. The update only lands if the stage is
// still the one read, so the history cannot name the wrong starting point.
//
// The two writes are not atomic: PostgREST runs each in its own transaction. If
// the history insert fails the move stands, and historyError says so.
export async function writeStageChange(
  supabase: SupabaseClient,
  dealId: number,
  patch: StagePatch,
): Promise<StageChangeResult> {
  const { data: before, error: readError } = await supabase
    .from("deals")
    .select("stage, is_active")
    .eq("id", dealId)
    .maybeSingle();
  if (readError) return failed(readError);
  if (!before) return failed({ message: `Deal ${dealId} was not found.` });
  // Already in that stage: nothing to write, and nothing went wrong.
  if (before.stage === patch.stage) return { error: null, historyError: null };

  const { data: moved, error: moveError } = await supabase
    .from("deals")
    .update(patch)
    .eq("id", dealId)
    .eq("stage", before.stage)
    .select("id");
  if (moveError) return failed(moveError);
  // RLS and a lost race both answer with no rows and no error.
  if (!moved?.length)
    return failed({
      message: `Deal ${dealId} was not moved: it changed while this was saving, or this login may not change it. Refresh and try again.`,
    });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const rows = stageEventRows(dealId, before, patch, {
    // db.now_iso(): UTC, second precision, no suffix.
    at: new Date().toISOString().slice(0, 19),
    actor: `crm:${user?.email ?? "unknown"}`,
  });
  const { error: historyError } = await supabase.from("deal_events").insert(rows);
  if (historyError) {
    console.error(
      `Deal ${dealId} moved to ${patch.stage}, but deal_events was not written: ${historyError.message}`,
    );
    return { error: null, historyError: historyError.message };
  }
  return { error: null, historyError: null };
}

// The deal_events rows for a move from `before` to `patch`: always the stage,
// and is_active when the move changes it, both as text.
function stageEventRows(
  dealId: number,
  before: { stage: string; is_active: number | null },
  patch: StagePatch,
  by: { at: string; actor: string },
): DealEventRow[] {
  const event = { deal_id: dealId, ...by, source: "crm-app" };
  const rows: DealEventRow[] = [
    { ...event, field: "stage", old_value: before.stage, new_value: patch.stage },
  ];
  if (before.is_active !== patch.is_active) {
    rows.push({
      ...event,
      field: "is_active",
      old_value: before.is_active === null ? null : String(before.is_active),
      new_value: String(patch.is_active),
    });
  }
  return rows;
}

function failed(error: { message: string }): StageChangeResult {
  return { error, historyError: null };
}
