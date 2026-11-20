// Store-hours seasons (migration 47, bj-finance #742): the store's opening
// hours as effective-dated periods (winter, summer). Every reader of
// store_hours reads these too and hands both to lib/coverage.ts, whose
// storeHoursFor picks the season in force on each date; before the first
// season, or before migration 47, the normal weekly pattern applies.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreHoursRow } from "@/lib/coverage";
import { isMissingTable } from "@/lib/storeHours";
import type { StoreHoursSeason } from "@/lib/types";

export const SEASON_COLUMNS = "effective_from, weekday, name, is_closed, opens, closes";

/** Every season row, oldest first. Before migration 47: none. A failed read says why. */
export async function loadStoreHoursSeasons(
  supabase: SupabaseClient,
): Promise<{ seasons: StoreHoursSeason[]; error: string | null }> {
  const { data, error } = await supabase.from("store_hours_seasons").select(SEASON_COLUMNS).order("effective_from").order("weekday");
  if (isMissingTable(error)) return { seasons: [], error: null };
  if (error) return { seasons: [], error: error.message };
  return { seasons: (data ?? []) as StoreHoursSeason[], error: null };
}

/** Season rows as lib/coverage.ts reads them, next to the normal pattern's. */
export function seasonHoursRows(seasons: StoreHoursSeason[]): StoreHoursRow[] {
  return seasons.map((s) => ({ weekday: s.weekday, is_closed: s.is_closed, opens: s.opens, closes: s.closes, effective_from: s.effective_from }));
}
