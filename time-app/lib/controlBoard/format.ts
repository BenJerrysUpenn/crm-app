// How the control board writes its numbers. Pure, shared by the board's lines
// (board.ts) and its components.

export function money(n: number, cents = false): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

/** A fraction as a percent, trailing zeros dropped: 0.25 -> "25%", 0.0125 -> "1.25%". */
export function pct(n: number, digits = 2): string {
  const s = (n * 100).toFixed(digits);
  return `${digits > 0 ? s.replace(/\.?0+$/, "") : s}%`;
}

/** A fraction as a percent with fixed places, for columns: 0.25 -> "25.00%". */
export function pctFixed(n: number, digits = 2): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function shortDate(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "2026-09-01" -> "Sep 2026". */
export function monthName(month: string): string {
  return new Date(`${month}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function per100(v: number): string {
  return `$${v.toFixed(3)} per $100 of wages`;
}

export function capWords(cap: number | null | undefined): string {
  return cap == null ? "on all wages" : `on the first ${money(cap)}`;
}
