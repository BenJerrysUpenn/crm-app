// Server-side reads for the Labor Hours Planning inputs on the Targets tab
// (bj-finance #742), as the signed-in manager: every store-hours season,
// every concession event revision (migration 47), and the closed
// days from today on (store_hours_exceptions, migration 24).
//
// Before migration 47 the seasons and events are not there: the section says
// so, and closed days still work.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingTable } from "@/lib/storeHours";
import type { StoreHoursException } from "@/lib/types";
import { NEEDS_MIGRATION_47 } from "./load";
import type { ConcessionEventRow, SeasonRow } from "./planningInputs";

export type PlanningInputsData = {
  /** Why the seasons and events cannot be shown (before migration 47), or null. */
  unavailable: string | null;
  seasons: SeasonRow[];
  concession: ConcessionEventRow[];
  /** Closed days and short hours from today on. */
  exceptions: StoreHoursException[];
  problems: string[];
};

export async function loadPlanningInputs(supabase: SupabaseClient, today: string): Promise<PlanningInputsData> {
  const [seasons, concession, exceptions] = await Promise.all([
    supabase.from("store_hours_seasons").select("effective_from, weekday, name, is_closed, opens, closes, review_by, source, method").order("effective_from"),
    supabase.from("concession_events").select("*"),
    supabase.from("store_hours_exceptions").select("date, label, is_closed, opens, closes, created_at").gte("date", today).order("date"),
  ]);
  const problems: string[] = [];
  const missing = isMissingTable(seasons.error) || isMissingTable(concession.error);
  for (const [what, res] of [["Store-hours seasons", seasons], ["Concession events", concession]] as const) {
    if (res.error && !isMissingTable(res.error)) problems.push(`${what} could not be read: ${res.error.message}`);
  }
  if (isMissingTable(exceptions.error)) problems.push("Closed days need migration 24.");
  else if (exceptions.error) problems.push(`Closed days could not be read: ${exceptions.error.message}`);

  // PostgREST returns numeric columns as strings.
  const rows = <T>(r: { data: unknown[] | null; error: unknown }) => (r.error ? [] : ((r.data ?? []) as T[]));
  return {
    unavailable: missing ? NEEDS_MIGRATION_47 : null,
    seasons: rows<SeasonRow>(seasons),
    concession: rows<ConcessionEventRow>(concession).map((e) => ({ ...e, expected_net_sales: Number(e.expected_net_sales) })),
    exceptions: rows<StoreHoursException>(exceptions),
    problems,
  };
}
