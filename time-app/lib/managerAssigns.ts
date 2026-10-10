// Catering shifts are assigned by a manager, never claimed.
//
// The CRM writes one open shift per crew member when a catering deal is booked
// (crm-app lib/cateringShifts.ts and lib/cateringShiftsPg.ts), and stamps each
// with the deal's id. Nothing else writes shifts.deal_id, so it is the marker.
// Alina, 2026-10-03: staff see these shifts on the schedule but "they should
// wait to be assigned by a manager." A manager assigns them from the schedule
// like any other shift, and the person still gets "New shift posted".
//
// Enforced on the server, not only in the page:
//   POST /api/shifts/:id/claim           refuses a non-manager (403)
//   POST /api/shifts/:id/request-pickup  refuses everyone (403); a manager
//                                         assigns instead of approving a request
//   migration_34.sql                      refuses a staff session that sets
//                                         employee_id on one through /rest/v1
// The schedule shows staff "Manager assigns" where the button would be.

export const MANAGER_ASSIGNS_ERROR =
  "Catering shifts are assigned by a manager. You can't pick this one up.";

export function managerAssignsOnly(shift: { deal_id?: number | null }): boolean {
  return shift.deal_id !== null && shift.deal_id !== undefined;
}
