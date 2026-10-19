// How many weeks ahead the Labor Hours Planning card shows (bj-finance #742):
// a slider from 4 to 52, 26 until one is chosen, saved with the view. Its
// own small module so the views code does not pull in the planning math.

export const PLANNING_WEEKS = { min: 4, default: 26, max: 52 } as const;

/** A saved week count, held to the slider's range; the default when unset. */
export function planningWeekCount(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return PLANNING_WEEKS.default;
  return Math.min(PLANNING_WEEKS.max, Math.max(PLANNING_WEEKS.min, Math.round(n)));
}
