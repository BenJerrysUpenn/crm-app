import { postException } from "@/lib/storeHoursExceptionRoutes";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POST /api/store-hours/exceptions
// Body: { date: "YYYY-MM-DD", label?: string, is_closed?: boolean,
//         opens?: "HH:MM", closes?: "HH:MM" }
// is_closed defaults to true — the common case is closing a single day.
// Upserts, so re-posting the same date edits that date rather than failing.
// Affects only this date; the weekly pattern is untouched. The Targets tab's
// closed days answer the same way (lib/storeHoursExceptionRoutes.ts).
// -> { exception: StoreHoursException }
export async function POST(request: Request) {
  return postException(request);
}
