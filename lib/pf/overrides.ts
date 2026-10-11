// Category corrections from /money's change-category button (bj-finance #223).
//
// A correction is "just this one" (scope transaction, keyed by Monarch's
// transaction Id) or "every charge from this merchant" (scope merchant, keyed
// by the merchant name as the feed shows it, case-insensitively). They are
// saved to public.pf_category_overrides (supabase/crm/011), which only the
// service role can touch; every caller here has already passed lib/pf/guard.
// The 08:00 bookkeeping pass applies them to the ledger and folds merchant
// corrections into the rules doc, so the page shows a saved correction at once
// and the totals catch up at the next pass.

import type { ExplorerRow } from "./types";

export type OverrideScope = "transaction" | "merchant";

export interface PfOverride {
  id: string;
  scope: OverrideScope;
  txn_id: string | null;
  merchant: string;
  category: string;
  created_at: string;
}

export interface OverrideInput {
  scope: OverrideScope;
  txn_id: string;
  merchant: string;
  category: string;
}

/** How a merchant is matched: the feed's 38-character name, lower-cased.
 *  The Python side (automation/pf_categories.merchant_key) does the same. */
export const merchantKey = (m: string) => m.trim().slice(0, 38).toLowerCase();

/** Validate a POST body. Returns the clean input or the reason it is refused. */
export function parseOverrideInput(
  body: unknown,
  categories: readonly string[],
): { ok: true; input: OverrideInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Bad body" };
  const b = body as Record<string, unknown>;
  const scope = b.scope;
  if (scope !== "transaction" && scope !== "merchant")
    return { ok: false, error: "scope must be transaction or merchant" };
  const txn = typeof b.txn_id === "string" ? b.txn_id.trim() : "";
  if (!txn || txn.length > 64) return { ok: false, error: "txn_id is required" };
  const merchant = typeof b.merchant === "string" ? b.merchant.trim() : "";
  if (!merchant || merchant.length > 200)
    return { ok: false, error: "merchant is required" };
  // Exact match on purpose: Monarch's names are byte-for-byte, trailing
  // space included, so nothing here trims the category.
  const category = typeof b.category === "string" ? b.category : "";
  if (!categories.includes(category))
    return { ok: false, error: "category is not one of the feed's categories" };
  return { ok: true, input: { scope, txn_id: txn, merchant, category } };
}

export interface CorrectedRow extends ExplorerRow {
  /** Set when a saved correction changed this row's category on the page
   *  ahead of the next bookkeeping pass. */
  corrected?: OverrideScope;
}

/** Rows with saved corrections laid over their category. Newest correction
 *  wins; a transaction correction beats a merchant one. Only `c` changes —
 *  the totals and lenses move when the 08:00 pass rebuilds the feed. */
export function applyOverrides(
  rows: ExplorerRow[],
  overrides: PfOverride[],
): CorrectedRow[] {
  const byTxn = new Map<string, PfOverride>();
  const byMerchant = new Map<string, PfOverride>();
  const sorted = [...overrides].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );
  for (const o of sorted) {
    if (o.scope === "transaction" && o.txn_id) byTxn.set(o.txn_id, o);
    else if (o.scope === "merchant") byMerchant.set(merchantKey(o.merchant), o);
  }
  return rows.map((r) => {
    if (!r.id) return r;
    const o = byTxn.get(r.id) ?? byMerchant.get(merchantKey(r.m));
    if (!o || o.category === r.c) return r;
    return { ...r, c: o.category, corrected: o.scope };
  });
}

// Minimal shape of the supabase-js client this module uses, so tests can
// stand one in without the real client.
interface OverridesTable {
  from(table: "pf_category_overrides"): {
    select(cols: string): {
      order(
        col: string,
        opts: { ascending: boolean },
      ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    };
    insert(row: Record<string, unknown>): {
      select(cols: string): {
        single(): PromiseLike<{
          data: unknown;
          error: { message: string; code?: string } | null;
        }>;
      };
    };
  };
}

const COLS = "id, scope, txn_id, merchant, category, created_at";

/** Every saved correction, oldest first. A read failure (including the table
 *  not existing before crm/011 is applied) yields none: the page still
 *  renders, without corrections laid over it. */
export async function loadOverrides(db: OverridesTable): Promise<PfOverride[]> {
  const { data, error } = await db
    .from("pf_category_overrides")
    .select(COLS)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data as PfOverride[];
}

/** Save one correction. `missing_table` means crm/011 is not applied yet. */
export async function saveOverride(
  db: OverridesTable,
  input: OverrideInput,
  userId: string,
): Promise<
  | { ok: true; override: PfOverride }
  | { ok: false; reason: "missing_table" | "failed"; message: string }
> {
  const { data, error } = await db
    .from("pf_category_overrides")
    .insert({ ...input, created_by: userId })
    .select(COLS)
    .single();
  if (error) {
    const missing = error.code === "42P01" || error.code === "PGRST205";
    return {
      ok: false,
      reason: missing ? "missing_table" : "failed",
      message: error.message,
    };
  }
  return { ok: true, override: data as PfOverride };
}
