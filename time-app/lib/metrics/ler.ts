// Labour efficiency ratio (bj-finance #671, ruling M4; Crabtree, Simple
// Numbers): gross profit / (wages + employer payroll tax [+ owner comp]).
// Target >= 2.0; under 1.5 the business is not viable.
//
// The owners are not paid, so LER leaves owner pay out (Alina, 2026-11-18):
// one line, with a switch on the card that puts it in at the house rate,
// $1,476 a week for the two owners (WEEKLY-01, Resolved), $6,396 a month
// (x 52 / 12).

import { round2 } from "./round.ts";

export const OWNER_COMP_WEEKLY = 1476;
export const OWNER_COMP_MONTHLY = Math.round((OWNER_COMP_WEEKLY * 52) / 12);

export const LER_TARGET = 2;
export const LER_FLOOR = 1.5;

type N = number | null | undefined;

/** LER to two places, or null when an input is missing or there is no labour cost. */
export function ler({ grossProfit, labour, ownerComp = 0 }: { grossProfit: N; labour: N; ownerComp?: number }): number | null {
  if (grossProfit == null || labour == null) return null;
  const all = labour + ownerComp;
  if (all <= 0) return null;
  return round2(grossProfit / all);
}

/** LER without owner pay and with it, for a week or a month. */
export function lerBoth(grossProfit: N, labour: N, per: "week" | "month"): { ler: number | null; withOwnerPay: number | null } {
  const ownerComp = per === "week" ? OWNER_COMP_WEEKLY : OWNER_COMP_MONTHLY;
  return { ler: ler({ grossProfit, labour }), withOwnerPay: ler({ grossProfit, labour, ownerComp }) };
}
