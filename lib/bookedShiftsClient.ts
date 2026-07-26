// Client-side trigger: ask the server to create the time-app draft shifts for a
// deal that just entered "Booked Unpaid". Fire-and-forget — the endpoint is
// idempotent (create once, never touch), and any failure is swallowed so it can
// never block or roll back the stage change itself.
export function requestBookedShifts(dealId: number): void {
  try {
    void fetch(`/api/deals/${dealId}/booked-shifts`, { method: "POST" }).catch(
      () => {},
    );
  } catch {
    // ignore
  }
}
