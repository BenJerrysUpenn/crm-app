// Labour efficiency ratio (bj-finance #671, ruling M4; Crabtree, Simple
// Numbers): gross profit / (wages + employer payroll tax + owner comp).
// Target >= 2.0; under 1.5 the business is not viable.
//
// The owners are not paid yet, so the page shows LER both ways, labelled:
//   paid    owner comp at the house rate, Alex $630 + Alina $846 = $1,476 a week
//           (WEEKLY-01, Resolved), $6,396 a month (x 52 / 12);
//   unpaid  owner comp 0.

import { round2 } from "./round.ts";

export const OWNER_COMP_WEEKLY = 630 + 846;
export const OWNER_COMP_MONTHLY = Math.round((OWNER_COMP_WEEKLY * 52) / 12);

export const LER_TARGET = 2;
export const LER_FLOOR = 1.5;

type N = number | null | undefined;

/** LER to two places, or null when an input is missing or there is no labour cost. */
export function ler({ grossProfit, wages, employerTax, ownerComp }: { grossProfit: N; wages: N; employerTax: N; ownerComp: number }): number | null {
  if (grossProfit == null || wages == null || employerTax == null) return null;
  const labour = wages + employerTax + ownerComp;
  if (labour <= 0) return null;
  return round2(grossProfit / labour);
}

export function lerPair(
  inputs: { grossProfit: N; wages: N; employerTax: N },
  per: "week" | "month",
): { paid: number | null; unpaid: number | null } {
  const ownerComp = per === "week" ? OWNER_COMP_WEEKLY : OWNER_COMP_MONTHLY;
  return { paid: ler({ ...inputs, ownerComp }), unpaid: ler({ ...inputs, ownerComp: 0 }) };
}
