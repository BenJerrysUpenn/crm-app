// The $600K sales targets by month and stream (bj-finance #671, frame of
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
// the year is rescaled back to $600,000 (the estimated net-zero year), the
// other 35 cells scaled by 595,000 / 579,575 with December PAX held at $5,000.
// Nothing on the page assumes a year total.
//
// Every row is on the NET basis (measure 'net'): the seller booked Aramark's
// net settlement. Gross vs net for concessions is not ruled yet, so the
// concessions rows are provisional, and the page measures concessions sales
// on whatever basis the target row says.

import type { SalesTargetRow, Stream } from "./targets.ts";

const BASIS = "$600K year x seller-era share (Penn + Ventures books, 2017-19, 2022-25, equal weights); bj-finance #671";
const CONCESSIONS_BASIS =
  "$600K table, seller-era share on our event calendar, net of Aramark; Dec PAX $5,000 (ruled 2026-10-10); PROVISIONAL: gross vs net not ruled; bj-finance #671";

const MONTHLY: Record<Exclude<Stream, "delivery">, number[]> = {
  in_store: [17271, 24576, 32515, 47290, 45574, 46973, 48057, 40843, 37190, 29638, 21554, 16834],
  catering: [1187, 1601, 2279, 12407, 17986, 20249, 17682, 19506, 12433, 5450, 3291, 3944],
  concessions: [18368, 0, 37094, 492, 2610, 2574, 1561, 463, 5497, 11, 0, 5000],
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
