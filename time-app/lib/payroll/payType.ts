// Salaried or hourly, per person — the pay-type column on the Team page.
//
// Alina, 2026-09-22 (bj-finance #519): "a pay-type column on the Team page
// (beside the QBO employee id cell), set by managers; once the §4.1 QBO roster
// read exists, the sheet flags a mismatch against QBO. `--qbo-map` stops being
// its home." The payroll sheet (bj-finance modules/payroll_sheet.py) reads
// profiles.pay_type and prints "salary" instead of hours for a salaried row.
//
// Pure and dependency-free, so `node --test` runs it and the route and the UI
// validate identically.

import type { Parsed } from "./qboEmployee.ts";

export const PAY_TYPES = ["hourly", "salaried"] as const;
export type PayType = (typeof PAY_TYPES)[number];

/** What the Team page shows for each value, including "not set". */
export const PAY_TYPE_LABELS: Record<PayType | "", string> = {
  "": "not set",
  hourly: "Hourly",
  salaried: "Salaried",
};

/**
 * Normalise a submitted pay type. Blank in any dialect is null ("not set"),
 * which the payroll sheet reports instead of assuming hourly; anything else must
 * be one of the two words the database CHECK allows.
 */
export function parsePayType(value: unknown): Parsed<PayType | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "Pay type must be text." };
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return { ok: true, value: null };
  if ((PAY_TYPES as readonly string[]).includes(trimmed)) return { ok: true, value: trimmed as PayType };
  return { ok: false, error: `Pay type must be one of: ${PAY_TYPES.join(", ")}.` };
}
