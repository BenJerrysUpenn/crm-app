// Adding one dated row for the control board (bj-finance #693): a board
// setting from the Targets tab, or a salary from the Team page. A change is a
// new row, never an edit (migration 43), and both routes answer the same way
// once their own checks have passed: the stored row, or why it was not stored.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingTable } from "@/lib/storeHours";
import { NEEDS_MIGRATION } from "./load";

/** Postgres: insufficient_privilege, what Row Level Security answers. */
const REFUSED_BY_DATABASE = "42501";

/** Per table: the key the stored row is answered under, and what a non-owner is told. */
export const DATED_TABLES = {
  control_settings: { answerAs: "setting", ownersOnly: "Only an owner can change the control board." },
  profile_salaries: { answerAs: "salary", ownersOnly: "Only an owner can set a salary." },
} as const;

export type DatedTable = keyof typeof DATED_TABLES;

/** Insert `row` into `table` as the signed-in caller and answer the route's response. */
export async function addDatedRow(supabase: SupabaseClient, table: DatedTable, row: object): Promise<NextResponse> {
  const { answerAs, ownersOnly } = DATED_TABLES[table];
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (isMissingTable(error)) return NextResponse.json({ error: NEEDS_MIGRATION }, { status: 503 });
  if (error?.code === REFUSED_BY_DATABASE) return NextResponse.json({ error: ownersOnly }, { status: 403 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ [answerAs]: data });
}
