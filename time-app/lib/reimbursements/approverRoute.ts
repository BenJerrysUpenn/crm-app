// What every Approver route on the finance site does after its financeAccess
// gate (bj-finance #210): the reimbursement exists, with its amounts,
// Adjustments and subject.

import { createClient } from "@/lib/supabase/server";
import { isMissingTable } from "@/lib/storeHours";
import { NextResponse } from "next/server";
import { NEEDS_MIGRATION, loadMileageCaps, loadRates, profileLite, readError, withAmounts, type AdjustmentRow, type MileageCaps, type ReimbursementRow, type WithAmounts } from "./server";
import type { MileageRate } from "./money";

/** A write that found the reimbursement no longer as the Approver read it (409). */
export const CHANGED = "It changed while you were looking. Reload and try again.";

type Ok = {
  res?: undefined;
  row: WithAmounts;
  subject: NonNullable<Awaited<ReturnType<typeof profileLite>>>;
  rates: MileageRate[];
  /** Its Catering Event's cap, for repricing it after a write (the deal does not change). */
  caps: MileageCaps;
  supabase: ReturnType<typeof createClient>;
};

export async function approverContext(idParam: string): Promise<Ok | { res: NextResponse }> {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return { res: NextResponse.json({ error: "Bad id" }, { status: 400 }) };
  const supabase = createClient();
  const { data, error } = await supabase.from("travel_reimbursements").select("*").eq("id", id).maybeSingle();
  if (isMissingTable(error)) return { res: NextResponse.json({ error: NEEDS_MIGRATION }, { status: 503 }) };
  if (error) return { res: NextResponse.json({ error: error.message }, { status: 400 }) };
  if (!data) return { res: NextResponse.json({ error: "Travel Reimbursement not found" }, { status: 404 }) };
  const rates = await loadRates(supabase);
  if (!rates.ok) return { res: NextResponse.json({ error: rates.error }, { status: 503 }) };
  const { data: adj, error: adjError } = await supabase.from("travel_reimbursement_adjustments").select("*").eq("reimbursement_id", id);
  if (adjError) return { res: NextResponse.json({ error: readError(adjError) }, { status: 503 }) };
  const subject = await profileLite((data as ReimbursementRow).profile_id);
  if (!subject) return { res: NextResponse.json({ error: "Its staff member was not found" }, { status: 404 }) };
  const found = data as ReimbursementRow;
  const caps = await loadMileageCaps(supabase, [found]);
  if (!caps.ok) return { res: NextResponse.json({ error: caps.error }, { status: 503 }) };
  const [row] = withAmounts([data as ReimbursementRow], rates.rates, (adj ?? []) as AdjustmentRow[], caps.caps);
  return { row, subject, rates: rates.rates, caps: caps.caps, supabase };
}
