// Adding one dated row for the control board (bj-finance #693): a board
// setting from the Targets tab, a salary from the Team page, or a concession
// or crew event revision (migration 47, bj-finance #742). A change is a new
// row, never an edit (migration 43), and every route answers the same way
// once its own checks have passed: the stored row, or why it was not stored.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingTable } from "@/lib/storeHours";
import { NEEDS_MIGRATION, NEEDS_MIGRATION_47 } from "./load";
import type { SeasonRow } from "./planningInputs";
import type { Parsed } from "./settings";

/** Postgres: insufficient_privilege, what Row Level Security answers. */
const REFUSED_BY_DATABASE = "42501";

/** Per table: the key the stored row is answered under, what a non-owner is told, and the migration that makes it. */
export const DATED_TABLES = {
  control_settings: { answerAs: "setting", ownersOnly: "Only an owner can change the control board.", needs: NEEDS_MIGRATION },
  profile_salaries: { answerAs: "salary", ownersOnly: "Only an owner can set a salary.", needs: NEEDS_MIGRATION },
  concession_events: { answerAs: "event", ownersOnly: "Only an owner can change the planning inputs.", needs: NEEDS_MIGRATION_47 },
  crew_events: { answerAs: "event", ownersOnly: "Only an owner can change the planning inputs.", needs: NEEDS_MIGRATION_47 },
} as const;

export type DatedTable = keyof typeof DATED_TABLES;

/** Insert `row` into `table` as the signed-in caller and answer the route's response. */
export async function addDatedRow(supabase: SupabaseClient, table: DatedTable, row: object): Promise<NextResponse> {
  const { answerAs, ownersOnly, needs } = DATED_TABLES[table];
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (isMissingTable(error)) return NextResponse.json({ error: needs }, { status: 503 });
  if (error?.code === REFUSED_BY_DATABASE) return NextResponse.json({ error: ownersOnly }, { status: 403 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ [answerAs]: data });
}

/**
 * Add a revision of a concession or crew event (migration 47). `parse` checks
 * the body against every event key on file: no key is a new event, a key not
 * on file is refused.
 */
export async function addEventRevision(
  supabase: SupabaseClient,
  table: "concession_events" | "crew_events",
  body: unknown,
  parse: (body: unknown, taken: Set<string>) => Parsed<object>,
): Promise<NextResponse> {
  const { data, error } = await supabase.from(table).select("event_key");
  if (isMissingTable(error)) return NextResponse.json({ error: NEEDS_MIGRATION_47 }, { status: 503 });
  if (error) return NextResponse.json({ error: `The events could not be read: ${error.message}` }, { status: 500 });
  const parsed = parse(body, new Set(((data ?? []) as { event_key: string }[]).map((r) => r.event_key)));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return addDatedRow(supabase, table, parsed.value);
}

export const SEASONS_OWNERS_ONLY = "Only an owner can change the store-hours seasons.";

/** Write a season's seven rows (parseSeasonInput); saving a season again replaces its rows. */
export async function saveSeason(supabase: SupabaseClient, rows: SeasonRow[]): Promise<NextResponse> {
  const { data, error } = await supabase.from("store_hours_seasons").upsert(rows, { onConflict: "effective_from,weekday" }).select();
  if (isMissingTable(error)) return NextResponse.json({ error: NEEDS_MIGRATION_47 }, { status: 503 });
  if (error?.code === REFUSED_BY_DATABASE) return NextResponse.json({ error: SEASONS_OWNERS_ONLY }, { status: 403 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ season: data });
}

/** Remove the season that starts on `from`. Removing one that is not there is a no-op. */
export async function removeSeason(supabase: SupabaseClient, from: string): Promise<NextResponse> {
  const { error } = await supabase.from("store_hours_seasons").delete().eq("effective_from", from);
  if (isMissingTable(error)) return NextResponse.json({ error: NEEDS_MIGRATION_47 }, { status: 503 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

