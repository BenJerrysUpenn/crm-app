// call_logs.called_at: when a call was made. A timestamp without time zone
// holding UTC ("2026-10-22T19:11:00"), the same naive-UTC shape as the deal
// timestamps (README "Timestamps") and as call_logs.created_at beside it.
//
// The drawer's datetime-local input holds Eastern wall-clock time, whatever
// the browser's zone, so every caller sees and types the time the rest of the
// app shows. The routes convert that Eastern time to UTC themselves: Vercel
// runs them in UTC, and `new Date()` on a naive string would read it in
// whatever zone the server happens to have.

import { nowIso } from "@/lib/callDesk/dealForm";
import { easternInputValue, parseEasternInput, parseNaiveUtc } from "@/lib/dateFormat";

// A Z or a numeric offset at the end: the value already names its instant.
const HAS_ZONE = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

// The call time a request carries, as its instant and as the naive-UTC text
// stored in called_at. A naive value is Eastern wall-clock time (the form);
// one with a Z or an offset keeps its instant. Null when it is not a time.
export function parseCalledAt(
  raw: string,
): { instant: Date; stored: string } | null {
  const value = raw.trim();
  const instant = HAS_ZONE.test(value)
    ? new Date(value)
    : parseEasternInput(value);
  if (!instant || Number.isNaN(instant.getTime())) return null;
  return { instant, stored: nowIso(instant) };
}

// The edit form's starting value for a stored called_at: its Eastern
// wall-clock time, "" when the stored text is not a time.
export function calledAtFormValue(stored: string): string {
  const instant = parseNaiveUtc(stored);
  return instant ? easternInputValue(instant) : "";
}

// The PATCH body for a call edit. The time goes only when the caller changed
// it, so saving untouched leaves called_at exactly as stored: its seconds, and
// which of the fall-back night's two 1:30 AMs it was, survive.
export function callEditBody(
  openedAt: string,
  editedAt: string,
  notes: string,
): { called_at?: string; notes: string } {
  return editedAt === openedAt ? { notes } : { called_at: editedAt, notes };
}
