// What every Approver route on the finance site does after its financeAccess
// gate (bj-finance #210): the reimbursement exists, with its amounts,
// Adjustments and subject.

import { createClient } from "@/lib/supabase/server";
import { isMissingTable } from "@/lib/storeHours";
import { NextResponse } from "next/server";
import { NEEDS_MIGRATION, loadRates, profileLite, withAmounts, type AdjustmentRow, type ReimbursementRow, type WithAmounts } from "./server";
import type { MileageRate } from "./money";

type Ok = {
  res?: undefined;
  row: WithAmounts;
  subject: NonNullable<Awaited<ReturnType<typeof profileLite>>>;
  rates: MileageRate[];
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
  const { data: adj } = await supabase.from("travel_reimbursement_adjustments").select("*").eq("reimbursement_id", id);
  const subject = await profileLite((data as ReimbursementRow).profile_id);
  if (!subject) return { res: NextResponse.json({ error: "Its staff member was not found" }, { status: 404 }) };
  const [row] = withAmounts([data as ReimbursementRow], rates.rates, (adj ?? []) as AdjustmentRow[]);
  return { row, subject, rates: rates.rates, supabase };
}
