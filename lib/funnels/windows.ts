// Time-window selector for the Funnels tab (bj-finance #422).
//
// Pure date arithmetic, no I/O, so it is unit-testable. The tab renders every
// metric over one of these windows; the value travels in the URL (?window=30)
// and every query lower-bounds on the resolved start instant.

export const WINDOWS = ["7", "30", "90", "semester"] as const;
export type WindowKey = (typeof WINDOWS)[number];

export const WINDOW_LABELS: Record<WindowKey, string> = {
  "7": "7 days",
  "30": "30 days",
  "90": "90 days",
  semester: "Semester to date",
};

export const DEFAULT_WINDOW: WindowKey = "30";

export function isWindowKey(v: string | null | undefined): v is WindowKey {
  return v != null && (WINDOWS as readonly string[]).includes(v);
}

export function parseWindow(v: string | null | undefined): WindowKey {
  return isWindowKey(v) ? v : DEFAULT_WINDOW;
}

/**
 * The Fall semester start for "semester to date". UPenn's fall term starts late
 * August; we anchor on Aug 1 of the year in question so early-August enquiries
 * are included. Before Aug 1 (spring/summer), fall back to Jan 1 so the label
 * still means "this academic block so far" rather than a future date.
 */
export function semesterStart(now: Date): Date {
  const year = now.getUTCFullYear();
  const augFirst = new Date(Date.UTC(year, 7, 1, 0, 0, 0)); // month 7 = August
  if (now >= augFirst) return augFirst;
  return new Date(Date.UTC(year, 0, 1, 0, 0, 0)); // Jan 1
}

/** The inclusive lower-bound instant for a window, relative to `now`. */
export function windowStart(window: WindowKey, now: Date): Date {
  if (window === "semester") return semesterStart(now);
  const days = Number(window);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** ISO string for the window start — what queries compare against. */
export function windowStartISO(window: WindowKey, now: Date): string {
  return windowStart(window, now).toISOString();
}
