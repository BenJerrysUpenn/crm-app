// The $650K sales targets by month and stream (bj-finance #671, frame of
// 2026-10-10, the 3-stream table): rebuilt from the seller's separate books,
// Three Scoops Penn (in-store, delivery included) and Three Scoops Ventures
// (catering, concessions). Seven seller years (2017-19, 2022-25), each
// weighted equally; concessions placed on our event calendar (Auto Show Jan,
// Flower Show Mar, PAX Dec).
//
// This is DATA, the same rows migration 39 seeds into public.sales_targets.
// The page reads the table; this copy is used only while the table does not
// exist yet, and math.test.ts keeps the two equal.
//
// Alina, 2026-10-10: December concessions (PAX) = $5,000, replacing the
// table's $20,425; the seller-era summer events stay in. Alina, 2026-10-12:
// the year is $650,000, the cash break-even once the seller note's principal
// and interest are paid; the other 35 cells are scaled by 645,000 / 579,575
// with December PAX held at $5,000.
// Nothing on the page assumes a year total.
//
// Every row is on the NET basis (measure 'net'): the seller booked Aramark's
// net settlement. Gross vs net for concessions is not ruled yet, so the
// concessions rows are provisional, and the page measures concessions sales
// on whatever basis the target row says.

import type { SalesTargetRow, Stream } from "./targets.ts";

const BASIS = "$650K year x seller-era share (Penn + Ventures books, 2017-19, 2022-25, equal weights); bj-finance #671";
const CONCESSIONS_BASIS =
  "$650K table, seller-era share on our event calendar, net of Aramark; Dec PAX $5,000 (ruled 2026-10-10); PROVISIONAL: gross vs net not ruled; bj-finance #671";

const MONTHLY: Record<Exclude<Stream, "delivery">, number[]> = {
  in_store: [18722, 26641, 35247, 51264, 49404, 50920, 52095, 44275, 40315, 32129, 23365, 18249],
  catering: [1287, 1735, 2471, 13449, 19498, 21951, 19168, 21145, 13478, 5908, 3568, 4276],
  concessions: [19912, 0, 40211, 533, 2829, 2790, 1693, 502, 5958, 12, 0, 5000],
};

export const SALES_TARGET_SEED: SalesTargetRow[] = [2026, 2027].flatMap((year) =>
  (Object.keys(MONTHLY) as (keyof typeof MONTHLY)[]).flatMap((stream) =>
    MONTHLY[stream].map((amount, i) => ({
      month: `${year}-${String(i + 1).padStart(2, "0")}-01`,
      stream,
      amount,
      basis: stream === "concessions" ? CONCESSIONS_BASIS : BASIS,
      provisional: stream === "concessions",
      measure: "net" as const,
    })),
  ),
);
