import { deleteException } from "@/lib/storeHoursExceptionRoutes";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// DELETE /api/store-hours/exceptions/2026-11-26
// Drops the override so the date goes back to its normal weekday hours.
// Deleting a date that has no exception is a no-op, not an error. -> { ok }
export async function DELETE(_request: Request, { params }: { params: { date: string } }) {
  return deleteException(params.date);
}
