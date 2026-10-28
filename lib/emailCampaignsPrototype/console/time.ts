// PROTOTYPE (bj-finance #811), throwaway. Eastern wall-clock helpers for the
// one-screen console. No library: Intl gives the New York parts of an instant.

const ET = "America/New_York";

const fmtParts = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

export type EtParts = { ymd: string; hour: number; minute: number; weekday: number };

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function etParts(d: Date): EtParts {
  const p = Object.fromEntries(fmtParts.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WD[p.weekday] ?? 0,
  };
}

/** The New York calendar day of an instant, 'YYYY-MM-DD'. */
export const etDay = (d: Date | string) => etParts(typeof d === "string" ? new Date(d) : d).ymd;

export const isWeekday = (d: Date) => {
  const w = etParts(d).weekday;
  return w >= 1 && w <= 5;
};

// Business hours for reply aging. PLACEHOLDER (spec section 9.1): Mon-Fri,
// 9:00 to 17:00 Eastern. Alina sets the real window.
export const BUSINESS = { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] } as const;

function inBusiness(d: Date): boolean {
  const p = etParts(d);
  return (BUSINESS.days as readonly number[]).includes(p.weekday) && p.hour >= BUSINESS.startHour && p.hour < BUSINESS.endHour;
}

const STEP = 5 * 60_000;

/** Business minutes between two instants, in 5-minute steps. */
export function businessMinutesBetween(from: Date, to: Date): number {
  let n = 0;
  let t = from.getTime();
  const end = to.getTime();
  // Guard: never walk more than 30 days.
  const stop = Math.min(end, t + 30 * 86_400_000);
  while (t < stop) {
    if (inBusiness(new Date(t))) n += 5;
    t += STEP;
  }
  return n;
}

/** The instant `minutes` business minutes before `now`. */
export function minusBusinessMinutes(now: Date, minutes: number): Date {
  let left = minutes;
  let t = now.getTime();
  let guard = 0;
  while (left > 0 && guard++ < 20_000) {
    t -= STEP;
    if (inBusiness(new Date(t))) left -= 5;
  }
  return new Date(t);
}

export function fmtAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 48) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: ET, day: "numeric", month: "short" });
const fmtDow = new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", day: "numeric", month: "short" });

export const timeEt = (d: Date | string) => fmtTime.format(typeof d === "string" ? new Date(d) : d).replace(" ", "").toLowerCase();
export const dateEt = (d: Date | string) => fmtDate.format(typeof d === "string" ? new Date(d) : d);
export const dowEt = (d: Date | string) => fmtDow.format(typeof d === "string" ? new Date(d) : d);

/** Whole days between two instants. */
export const daysBetween = (a: Date | string, b: Date | string) =>
  Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
